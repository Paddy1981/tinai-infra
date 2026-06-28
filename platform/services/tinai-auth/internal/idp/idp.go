// Package idp turns tinai-auth into an OIDC *provider* (IdP), so first-party
// apps (Headscale/Trunk, dashboard, ...) can use it as their login server.
//
// The OIDC protocol itself is handled by github.com/zitadel/oidc (pkg/op) — we
// only implement the op.Storage backing it plus a small login page that
// authenticates against the existing users table. It is mounted under the
// /oidc/ path prefix so it never collides with the existing /api/v1/auth routes.
//
// Mounting is gated on OIDC_SIGNING_KEY: if that env var is unset the IdP is not
// mounted at all and the service behaves exactly as before.
//
// Env:
//
//	OIDC_SIGNING_KEY   RSA private key (PEM, PKCS#1 or PKCS#8) used to sign id_tokens (RS256). Required to enable.
//	OIDC_ISSUER        Issuer URL incl. path prefix. Default https://auth.tinai.cloud/oidc
//	OIDC_IDP_CLIENTS   JSON: [{"id":"headscale","secret":"...","redirect_uris":["https://trunk.tinai.cloud/oidc/callback"]}]
//	OIDC_CRYPTO_KEY    Seed for the op's internal AES key (sha256'd to 32 bytes). Defaults to a hash of JWT_SECRET.
//
// ponytail: single-replica in-memory auth-request/token store (Deployment is
// replicas:1). Move to Redis if it is ever scaled out.
package idp

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	"github.com/zitadel/oidc/v3/pkg/oidc"
	"github.com/zitadel/oidc/v3/pkg/op"

	"tinai.cloud/auth/internal/auth"
)

const (
	accessTokenTTL = 5 * time.Minute
	idTokenTTL     = time.Hour
)

// Mount wires the OIDC provider onto mux under /oidc/. It returns (false, nil)
// when OIDC_SIGNING_KEY is unset — the caller leaves the service unchanged.
func Mount(mux *http.ServeMux, db *sql.DB, jwtSecret string, logger *slog.Logger) (bool, error) {
	keyPEM := os.Getenv("OIDC_SIGNING_KEY")
	if keyPEM == "" {
		logger.Info("idp: OIDC_SIGNING_KEY not set, OIDC provider disabled")
		return false, nil
	}
	priv, err := parseRSAPrivateKey(keyPEM)
	if err != nil {
		return false, fmt.Errorf("parse OIDC_SIGNING_KEY: %w", err)
	}

	issuer := getEnv("OIDC_ISSUER", "https://auth.tinai.cloud/oidc")
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false, fmt.Errorf("invalid OIDC_ISSUER %q", issuer)
	}
	// The issuer must carry a path prefix (e.g. /oidc): this service already
	// owns root paths (/api/v1/auth, /metrics, /healthz), so the OP cannot mount
	// at "/" without swallowing them.
	prefix := strings.TrimRight(u.Path, "/")
	if prefix == "" {
		return false, fmt.Errorf("OIDC_ISSUER %q must include a path prefix (e.g. https://auth.tinai.cloud/oidc)", issuer)
	}

	clients, err := loadClients(os.Getenv("OIDC_IDP_CLIENTS"))
	if err != nil {
		return false, fmt.Errorf("parse OIDC_IDP_CLIENTS: %w", err)
	}
	if len(clients) == 0 {
		logger.Warn("idp: no clients configured (OIDC_IDP_CLIENTS empty); discovery works but no app can log in")
	}

	store := &storage{
		db:           db,
		clients:      clients,
		authRequests: map[string]*authReq{},
		codes:        map[string]string{},
		tokens:       map[string]*token{},
		signingKey: signingKey{
			id:  keyIDFromPub(&priv.PublicKey),
			alg: jose.RS256,
			key: priv,
		},
	}

	cryptoSeed := getEnv("OIDC_CRYPTO_KEY", jwtSecret)
	config := &op.Config{
		CryptoKey:      sha256.Sum256([]byte(cryptoSeed)),
		CodeMethodS256: true, // enable PKCE (S256)
		AuthMethodPost: true, // allow client_secret_post in addition to Basic
	}
	provider, err := op.NewOpenIDProvider(issuer, config, store,
		op.WithLogger(logger.WithGroup("op")),
	)
	if err != nil {
		return false, fmt.Errorf("new OIDC provider: %w", err)
	}

	// Login bridge. The OP redirects the browser to the client's LoginURL
	// (under /oidc/login/username); after we verify the password we redirect to
	// the OP's auth callback to complete the code flow.
	callback := op.AuthCallbackURL(provider)
	issuerInterceptor := op.NewIssuerInterceptor(provider.IssuerFromRequest)
	l := &login{store: store, callback: callback}

	mux.HandleFunc("GET "+prefix+"/login/username", l.renderForm)
	mux.Handle("POST "+prefix+"/login/username", issuerInterceptor.HandlerFunc(l.submit))
	// Everything else under the prefix is the OP handler (discovery, authorize,
	// token, keys, userinfo). More specific patterns above win in Go 1.22 mux.
	mux.Handle(prefix+"/", http.StripPrefix(prefix, provider))

	logger.Info("idp: OIDC provider mounted", "issuer", issuer, "clients", len(clients))
	return true, nil
}

func loginURLFor(prefix string) func(string) string {
	return func(id string) string {
		return prefix + "/login/username?authRequestID=" + url.QueryEscape(id)
	}
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

type clientConf struct {
	ID           string   `json:"id"`
	Secret       string   `json:"secret"`
	RedirectURIs []string `json:"redirect_uris"`
}

func loadClients(raw string) (map[string]*idpClient, error) {
	out := map[string]*idpClient{}
	if raw == "" {
		return out, nil
	}
	var confs []clientConf
	if err := json.Unmarshal([]byte(raw), &confs); err != nil {
		return nil, err
	}
	prefix := pathPrefix()
	for _, c := range confs {
		if c.ID == "" || len(c.RedirectURIs) == 0 {
			return nil, fmt.Errorf("client %q: id and redirect_uris are required", c.ID)
		}
		out[c.ID] = &idpClient{
			id:           c.ID,
			secret:       c.Secret,
			redirectURIs: c.RedirectURIs,
			loginURL:     loginURLFor(prefix),
		}
	}
	return out, nil
}

func pathPrefix() string {
	u, err := url.Parse(getEnv("OIDC_ISSUER", "https://auth.tinai.cloud/oidc"))
	if err != nil {
		return ""
	}
	return strings.TrimRight(u.Path, "/")
}

// idpClient implements op.Client for a confidential authorization-code client.
type idpClient struct {
	id           string
	secret       string
	redirectURIs []string
	loginURL     func(string) string
}

var _ op.Client = (*idpClient)(nil)

func (c *idpClient) GetID() string                       { return c.id }
func (c *idpClient) RedirectURIs() []string              { return c.redirectURIs }
func (c *idpClient) PostLogoutRedirectURIs() []string    { return nil }
func (c *idpClient) ApplicationType() op.ApplicationType { return op.ApplicationTypeWeb }
func (c *idpClient) AuthMethod() oidc.AuthMethod {
	if c.secret == "" {
		return oidc.AuthMethodNone // public client, PKCE only
	}
	return oidc.AuthMethodBasic
}
func (c *idpClient) ResponseTypes() []oidc.ResponseType {
	return []oidc.ResponseType{oidc.ResponseTypeCode}
}
func (c *idpClient) GrantTypes() []oidc.GrantType        { return []oidc.GrantType{oidc.GrantTypeCode} }
func (c *idpClient) LoginURL(id string) string           { return c.loginURL(id) }
func (c *idpClient) AccessTokenType() op.AccessTokenType { return op.AccessTokenTypeBearer }
func (c *idpClient) IDTokenLifetime() time.Duration      { return idTokenTTL }
func (c *idpClient) DevMode() bool                       { return false }
func (c *idpClient) RestrictAdditionalIdTokenScopes() func([]string) []string {
	return func(scopes []string) []string { return scopes }
}
func (c *idpClient) RestrictAdditionalAccessTokenScopes() func([]string) []string {
	return func(scopes []string) []string { return scopes }
}
func (c *idpClient) IsScopeAllowed(scope string) bool     { return false }
func (c *idpClient) IDTokenUserinfoClaimsAssertion() bool { return true }
func (c *idpClient) ClockSkew() time.Duration             { return 0 }

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

type signingKey struct {
	id  string
	alg jose.SignatureAlgorithm
	key *rsa.PrivateKey
}

func (k *signingKey) SignatureAlgorithm() jose.SignatureAlgorithm { return k.alg }
func (k *signingKey) Key() any                                    { return k.key }
func (k *signingKey) ID() string                                  { return k.id }

type publicKey struct{ *signingKey }

func (k *publicKey) ID() string                         { return k.id }
func (k *publicKey) Algorithm() jose.SignatureAlgorithm { return k.alg }
func (k *publicKey) Use() string                        { return "sig" }
func (k *publicKey) Key() any                           { return &k.key.PublicKey }

func keyIDFromPub(pub *rsa.PublicKey) string {
	der, _ := x509.MarshalPKIXPublicKey(pub)
	sum := sha256.Sum256(der)
	return fmt.Sprintf("%x", sum[:8])
}

func parseRSAPrivateKey(pemStr string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemStr))
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	keyAny, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := keyAny.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("not an RSA private key")
	}
	return rsaKey, nil
}

// ---------------------------------------------------------------------------
// Token (opaque bearer, in-memory)
// ---------------------------------------------------------------------------

type token struct {
	id            string
	applicationID string
	subject       string
	audience      []string
	scopes        []string
	expiration    time.Time
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type storage struct {
	db         *sql.DB
	clients    map[string]*idpClient
	signingKey signingKey

	lock         sync.Mutex
	authRequests map[string]*authReq
	codes        map[string]string // code -> authRequest id
	tokens       map[string]*token // accessTokenID -> token
}

var (
	_ op.Storage                   = (*storage)(nil)
	_ op.CanSetUserinfoFromRequest = (*storage)(nil)
)

func (s *storage) CreateAuthRequest(ctx context.Context, req *oidc.AuthRequest, userID string) (op.AuthRequest, error) {
	if len(req.Prompt) == 1 && req.Prompt[0] == "none" {
		return nil, oidc.ErrLoginRequired()
	}
	ar := &authReq{
		id:            uuid.NewString(),
		clientID:      req.ClientID,
		callbackURI:   req.RedirectURI,
		state:         req.State,
		scopes:        req.Scopes,
		responseType:  req.ResponseType,
		nonce:         req.Nonce,
		userID:        userID,
		creationDate:  time.Now(),
		codeChallenge: req.CodeChallenge,
		codeChallMeth: string(req.CodeChallengeMethod),
	}
	s.lock.Lock()
	s.authRequests[ar.id] = ar
	s.lock.Unlock()
	return ar, nil
}

func (s *storage) AuthRequestByID(ctx context.Context, id string) (op.AuthRequest, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	ar, ok := s.authRequests[id]
	if !ok {
		return nil, errors.New("auth request not found")
	}
	return ar, nil
}

func (s *storage) AuthRequestByCode(ctx context.Context, code string) (op.AuthRequest, error) {
	s.lock.Lock()
	id, ok := s.codes[code]
	s.lock.Unlock()
	if !ok {
		return nil, errors.New("code invalid or expired")
	}
	return s.AuthRequestByID(ctx, id)
}

func (s *storage) SaveAuthCode(ctx context.Context, id, code string) error {
	s.lock.Lock()
	s.codes[code] = id
	s.lock.Unlock()
	return nil
}

func (s *storage) DeleteAuthRequest(ctx context.Context, id string) error {
	s.lock.Lock()
	defer s.lock.Unlock()
	delete(s.authRequests, id)
	for code, rid := range s.codes {
		if rid == id {
			delete(s.codes, code)
		}
	}
	return nil
}

func (s *storage) CreateAccessToken(ctx context.Context, req op.TokenRequest) (string, time.Time, error) {
	var appID string
	if ar, ok := req.(*authReq); ok {
		appID = ar.clientID
	}
	t := &token{
		id:            uuid.NewString(),
		applicationID: appID,
		subject:       req.GetSubject(),
		audience:      req.GetAudience(),
		scopes:        req.GetScopes(),
		expiration:    time.Now().Add(accessTokenTTL),
	}
	s.lock.Lock()
	s.tokens[t.id] = t
	s.lock.Unlock()
	return t.id, t.expiration, nil
}

// Refresh tokens are intentionally unsupported (no offline_access, no refresh
// grant on any client). ponytail: inert stubs; add a refresh store if a client
// ever needs offline_access.
func (s *storage) CreateAccessAndRefreshTokens(ctx context.Context, req op.TokenRequest, current string) (string, string, time.Time, error) {
	return "", "", time.Time{}, errors.New("refresh tokens not supported")
}
func (s *storage) TokenRequestByRefreshToken(ctx context.Context, refreshToken string) (op.RefreshTokenRequest, error) {
	return nil, errors.New("refresh tokens not supported")
}
func (s *storage) GetRefreshTokenInfo(ctx context.Context, clientID, tokenStr string) (string, string, error) {
	return "", "", op.ErrInvalidRefreshToken
}

func (s *storage) TerminateSession(ctx context.Context, userID, clientID string) error {
	s.lock.Lock()
	defer s.lock.Unlock()
	for id, t := range s.tokens {
		if t.subject == userID && t.applicationID == clientID {
			delete(s.tokens, id)
		}
	}
	return nil
}

func (s *storage) RevokeToken(ctx context.Context, tokenIDOrToken, userID, clientID string) *oidc.Error {
	s.lock.Lock()
	defer s.lock.Unlock()
	if t, ok := s.tokens[tokenIDOrToken]; ok {
		if t.applicationID != clientID {
			return oidc.ErrInvalidClient().WithDescription("token was not issued for this client")
		}
		delete(s.tokens, tokenIDOrToken)
	}
	return nil
}

func (s *storage) SigningKey(ctx context.Context) (op.SigningKey, error) { return &s.signingKey, nil }
func (s *storage) SignatureAlgorithms(ctx context.Context) ([]jose.SignatureAlgorithm, error) {
	return []jose.SignatureAlgorithm{s.signingKey.alg}, nil
}
func (s *storage) KeySet(ctx context.Context) ([]op.Key, error) {
	return []op.Key{&publicKey{&s.signingKey}}, nil
}

func (s *storage) GetClientByClientID(ctx context.Context, clientID string) (op.Client, error) {
	c, ok := s.clients[clientID]
	if !ok {
		return nil, errors.New("client not found")
	}
	return c, nil
}

func (s *storage) AuthorizeClientIDSecret(ctx context.Context, clientID, clientSecret string) error {
	c, ok := s.clients[clientID]
	if !ok {
		return errors.New("client not found")
	}
	if c.secret == "" || c.secret != clientSecret {
		return errors.New("invalid client secret")
	}
	return nil
}

// SetUserinfoFromScopes is deprecated; SetUserinfoFromRequest is used instead.
func (s *storage) SetUserinfoFromScopes(ctx context.Context, ui *oidc.UserInfo, userID, clientID string, scopes []string) error {
	return nil
}

func (s *storage) SetUserinfoFromRequest(ctx context.Context, ui *oidc.UserInfo, req op.IDTokenRequest, scopes []string) error {
	return s.setUserinfo(ctx, ui, req.GetSubject(), scopes)
}

func (s *storage) SetUserinfoFromToken(ctx context.Context, ui *oidc.UserInfo, tokenID, subject, origin string) error {
	s.lock.Lock()
	t, ok := s.tokens[tokenID]
	s.lock.Unlock()
	if !ok || t.expiration.Before(time.Now()) {
		return errors.New("token is invalid or has expired")
	}
	return s.setUserinfo(ctx, ui, t.subject, t.scopes)
}

func (s *storage) SetIntrospectionFromToken(ctx context.Context, ir *oidc.IntrospectionResponse, tokenID, subject, clientID string) error {
	s.lock.Lock()
	t, ok := s.tokens[tokenID]
	s.lock.Unlock()
	if !ok || t.expiration.Before(time.Now()) {
		return errors.New("token is invalid or has expired")
	}
	for _, aud := range t.audience {
		if aud == clientID {
			ui := new(oidc.UserInfo)
			if err := s.setUserinfo(ctx, ui, t.subject, t.scopes); err != nil {
				return err
			}
			ir.SetUserInfo(ui)
			ir.Scope = t.scopes
			ir.ClientID = t.applicationID
			return nil
		}
	}
	return errors.New("token is not valid for this client")
}

func (s *storage) GetPrivateClaimsFromScopes(ctx context.Context, userID, clientID string, scopes []string) (map[string]any, error) {
	role, tenantID, _, _, err := s.lookupUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"role": role, "tenant_id": tenantID}, nil
}

func (s *storage) GetKeyByIDAndClientID(ctx context.Context, keyID, clientID string) (*jose.JSONWebKey, error) {
	return nil, errors.New("private_key_jwt clients not supported")
}

func (s *storage) ValidateJWTProfileScopes(ctx context.Context, userID string, scopes []string) ([]string, error) {
	allowed := make([]string, 0, len(scopes))
	for _, sc := range scopes {
		if sc == oidc.ScopeOpenID {
			allowed = append(allowed, sc)
		}
	}
	return allowed, nil
}

func (s *storage) Health(ctx context.Context) error { return s.db.PingContext(ctx) }

// setUserinfo fills the id_token / userinfo claims from the users table. role
// and tenant_id are always included so downstream tinai apps get tenant context.
func (s *storage) setUserinfo(ctx context.Context, ui *oidc.UserInfo, userID string, scopes []string) error {
	role, tenantID, email, emailVerified, err := s.lookupUser(ctx, userID)
	if err != nil {
		return err
	}
	ui.Subject = userID
	for _, sc := range scopes {
		switch sc {
		case oidc.ScopeEmail:
			ui.Email = email
			ui.EmailVerified = oidc.Bool(emailVerified)
		case oidc.ScopeProfile:
			ui.PreferredUsername = email
		}
	}
	ui.AppendClaims("role", role)
	ui.AppendClaims("tenant_id", tenantID)
	return nil
}

func (s *storage) lookupUser(ctx context.Context, userID string) (role, tenantID, email string, emailVerified bool, err error) {
	var em sql.NullString
	err = s.db.QueryRowContext(ctx,
		`SELECT role, tenant_id, email, COALESCE(email_verified, true) FROM users WHERE id=$1`,
		userID,
	).Scan(&role, &tenantID, &em, &emailVerified)
	if err != nil {
		return "", "", "", false, fmt.Errorf("user not found: %w", err)
	}
	return role, tenantID, em.String, emailVerified, nil
}

// ---------------------------------------------------------------------------
// authReq implements op.AuthRequest
// ---------------------------------------------------------------------------

type authReq struct {
	id            string
	clientID      string
	callbackURI   string
	state         string
	scopes        []string
	responseType  oidc.ResponseType
	nonce         string
	userID        string
	creationDate  time.Time
	codeChallenge string
	codeChallMeth string

	done     bool
	authTime time.Time
}

var _ op.AuthRequest = (*authReq)(nil)

func (a *authReq) GetID() string  { return a.id }
func (a *authReq) GetACR() string { return "" }
func (a *authReq) GetAMR() []string {
	if a.done {
		return []string{"pwd"}
	}
	return nil
}
func (a *authReq) GetAudience() []string  { return []string{a.clientID} }
func (a *authReq) GetAuthTime() time.Time { return a.authTime }
func (a *authReq) GetClientID() string    { return a.clientID }
func (a *authReq) GetCodeChallenge() *oidc.CodeChallenge {
	if a.codeChallenge == "" {
		return nil
	}
	method := oidc.CodeChallengeMethodPlain
	if a.codeChallMeth == "S256" {
		method = oidc.CodeChallengeMethodS256
	}
	return &oidc.CodeChallenge{Challenge: a.codeChallenge, Method: method}
}
func (a *authReq) GetNonce() string                   { return a.nonce }
func (a *authReq) GetRedirectURI() string             { return a.callbackURI }
func (a *authReq) GetResponseType() oidc.ResponseType { return a.responseType }
func (a *authReq) GetResponseMode() oidc.ResponseMode { return "" }
func (a *authReq) GetScopes() []string                { return a.scopes }
func (a *authReq) GetState() string                   { return a.state }
func (a *authReq) GetSubject() string                 { return a.userID }
func (a *authReq) Done() bool                         { return a.done }

// ---------------------------------------------------------------------------
// Login bridge
// ---------------------------------------------------------------------------

type login struct {
	store    *storage
	callback func(context.Context, string) string
}

var loginTmpl = template.Must(template.New("login").Parse(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Sign in · Tinai</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;background:#0b1020;color:#e8eefc;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#141b33;padding:2rem;border-radius:12px;width:320px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
h1{font-size:1.1rem;margin:0 0 1rem}input{width:100%;box-sizing:border-box;padding:.6rem;margin:.35rem 0;border-radius:8px;border:1px solid #2a3658;background:#0b1020;color:#e8eefc}
button{width:100%;padding:.65rem;margin-top:.8rem;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
.err{color:#fca5a5;font-size:.85rem;min-height:1rem}</style></head>
<body><form method="post" action="login/username">
<h1>Sign in to continue</h1>
<div class="err">{{.Error}}</div>
<input type="hidden" name="id" value="{{.ID}}">
<input type="email" name="username" placeholder="Email" autocomplete="username" required autofocus>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form></body></html>`))

func (l *login) renderForm(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	renderLogin(w, r.FormValue("authRequestID"), "")
}

func renderLogin(w http.ResponseWriter, id, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = loginTmpl.Execute(w, struct{ ID, Error string }{ID: id, Error: errMsg})
}

func (l *login) submit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "cannot parse form", http.StatusBadRequest)
		return
	}
	id := r.FormValue("id")
	if err := l.store.checkLogin(r.Context(), r.FormValue("username"), r.FormValue("password"), id); err != nil {
		renderLogin(w, id, "Invalid email or password.")
		return
	}
	http.Redirect(w, r, l.callback(r.Context(), id), http.StatusFound)
}

// checkLogin verifies the password against the users table and marks the auth
// request complete. Unverified-email accounts are rejected.
func (s *storage) checkLogin(ctx context.Context, email, password, reqID string) error {
	s.lock.Lock()
	ar, ok := s.authRequests[reqID]
	s.lock.Unlock()
	if !ok {
		return errors.New("auth request not found")
	}

	var userID, passwordHash string
	var emailVerified bool
	err := s.db.QueryRowContext(ctx,
		`SELECT id, password_hash, COALESCE(email_verified, true) FROM users WHERE email=$1`,
		email,
	).Scan(&userID, &passwordHash, &emailVerified)
	if err != nil {
		return errors.New("invalid credentials")
	}
	if !emailVerified || !auth.VerifyPassword(password, passwordHash) {
		return errors.New("invalid credentials")
	}

	s.lock.Lock()
	ar.userID = userID
	ar.done = true
	ar.authTime = time.Now()
	s.lock.Unlock()
	return nil
}

// ---------------------------------------------------------------------------

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
