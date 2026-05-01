package main

import (
	"bufio"
	"database/sql"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	_ "github.com/lib/pq"
)

const (
	defaultDatabaseURL = "" // must be set via DATABASE_URL env var — never hardcode credentials
	defaultTLEURL      = "https://celestrak.org/NORAD/elements/gp.php?GROUP=earth-obs&FORMAT=tle"
)

// Satellite holds parsed TLE data for a single satellite.
type Satellite struct {
	NORADId  int
	Name     string
	TLELine1 string
	TLELine2 string
	Epoch    time.Time
	Country  string
	Category string
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// fetchTLE downloads the TLE text from the given URL and returns it as a string.
func fetchTLE(url string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "tinai-tle/1.0 (tinai.cloud; space@tinai.cloud)")
	req.Header.Set("Accept", "text/plain")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("http get %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected status %d from %s", resp.StatusCode, url)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("reading response body: %w", err)
	}
	preview := string(body)
	if len(preview) > 120 {
		preview = preview[:120]
	}
	log.Printf("response preview: %q", preview)
	return string(body), nil
}

// parseTLEText parses a raw TLE text body into a slice of Satellite structs.
// The format is repeating 3-line sets: name, TLE line 1, TLE line 2.
func parseTLEText(body string) ([]Satellite, error) {
	var lines []string
	scanner := bufio.NewScanner(strings.NewReader(body))
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r\n")
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scanning TLE body: %w", err)
	}

	if len(lines)%3 != 0 {
		log.Printf("warning: TLE line count %d is not a multiple of 3; trailing lines will be ignored", len(lines))
	}

	var sats []Satellite
	for i := 0; i+2 < len(lines); i += 3 {
		name := strings.TrimSpace(lines[i])
		line1 := lines[i+1]
		line2 := lines[i+2]

		noradID, err := parseNORADID(line1)
		if err != nil {
			log.Printf("warning: could not parse NORAD ID from line1 %q: %v — skipping", line1, err)
			continue
		}

		epoch, err := parseEpoch(line1)
		if err != nil {
			log.Printf("warning: could not parse epoch for %q: %v — using zero time", name, err)
			epoch = time.Time{}
		}

		country := detectCountry(name)

		sats = append(sats, Satellite{
			NORADId:  noradID,
			Name:     name,
			TLELine1: line1,
			TLELine2: line2,
			Epoch:    epoch,
			Country:  country,
			Category: "earth-obs",
		})
	}
	return sats, nil
}

// parseNORADID extracts the NORAD catalog ID from TLE line 1, positions 2-7 (0-indexed).
// TLE line 1 format: 1 NNNNNC ...
// Characters at index 2-6 (5 chars) are the NORAD catalog number.
func parseNORADID(line1 string) (int, error) {
	if len(line1) < 7 {
		return 0, fmt.Errorf("line1 too short (%d chars)", len(line1))
	}
	raw := strings.TrimSpace(line1[2:7])
	id, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("atoi(%q): %w", raw, err)
	}
	return id, nil
}

// parseEpoch parses the epoch field from TLE line 1, positions 18-32 (0-indexed).
// Format: YYddd.ffffffff
//   - YY: 2-digit year (>=57 → 1900+YY, else 2000+YY)
//   - ddd.ffffffff: day of year with decimal fraction
func parseEpoch(line1 string) (time.Time, error) {
	if len(line1) < 32 {
		return time.Time{}, fmt.Errorf("line1 too short for epoch (%d chars)", len(line1))
	}
	raw := strings.TrimSpace(line1[18:32])
	if len(raw) < 3 {
		return time.Time{}, fmt.Errorf("epoch field too short: %q", raw)
	}

	// Extract 2-digit year
	yearStr := raw[:2]
	yy, err := strconv.Atoi(yearStr)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing year %q: %w", yearStr, err)
	}
	var year int
	if yy >= 57 {
		year = 1900 + yy
	} else {
		year = 2000 + yy
	}

	// Extract day-of-year (e.g. "001.5" → day 1 + 0.5 days)
	dayStr := raw[2:]
	dayFrac, err := strconv.ParseFloat(dayStr, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("parsing day fraction %q: %w", dayStr, err)
	}

	// day-of-year is 1-based in TLE; subtract 1 for AddDate
	dayInt := int(dayFrac)           // integer day of year (1-based)
	fracDay := dayFrac - float64(dayInt) // fractional part

	// Start from Jan 1 of the year and add (dayInt - 1) whole days
	base := time.Date(year, time.January, 1, 0, 0, 0, 0, time.UTC)
	base = base.AddDate(0, 0, dayInt-1)

	// Add fractional day as nanoseconds
	totalNanos := int64(fracDay * 24 * float64(time.Hour))
	epoch := base.Add(time.Duration(totalNanos))

	// Sanity check: epoch should be a reasonable satellite launch date
	earliest := time.Date(1957, 1, 1, 0, 0, 0, 0, time.UTC)
	if epoch.Before(earliest) {
		return time.Time{}, fmt.Errorf("parsed epoch %v is before 1957", epoch)
	}

	return epoch, nil
}

// detectCountry returns a country code based on known patterns in the satellite name.
func detectCountry(name string) string {
	upper := strings.ToUpper(name)

	indianPatterns := []string{
		"CARTOSAT", "RESOURCESAT", "RISAT", "IRS-",
		"INSAT", "GSAT", "OCEANSAT", "ADITYA", "SARAL", "MEGHA",
	}
	for _, p := range indianPatterns {
		if strings.Contains(upper, p) {
			return "INDIA"
		}
	}

	usaPatterns := []string{"LANDSAT", "AQUA", "TERRA", "SUOMI"}
	for _, p := range usaPatterns {
		if strings.Contains(upper, p) {
			return "USA"
		}
	}

	euPatterns := []string{"SENTINEL", "METOP"}
	for _, p := range euPatterns {
		if strings.Contains(upper, p) {
			return "EU"
		}
	}

	japanPatterns := []string{"HIMAWARI", "ALOS"}
	for _, p := range japanPatterns {
		if strings.Contains(upper, p) {
			return "JAPAN"
		}
	}

	return "OTHER"
}

// ensureSchema creates the required extension and table if they do not exist.
func ensureSchema(db *sql.DB) error {
	_, err := db.Exec(`CREATE EXTENSION IF NOT EXISTS postgis`)
	if err != nil {
		return fmt.Errorf("create postgis extension: %w", err)
	}

	_, err = db.Exec(`
CREATE TABLE IF NOT EXISTS satellites (
  id         SERIAL PRIMARY KEY,
  norad_id   INTEGER UNIQUE NOT NULL,
  name       VARCHAR(255) NOT NULL,
  tle_line1  TEXT NOT NULL,
  tle_line2  TEXT NOT NULL,
  epoch      TIMESTAMPTZ,
  country    VARCHAR(63) DEFAULT 'OTHER',
  category   VARCHAR(63) DEFAULT 'earth-obs',
  updated_at TIMESTAMPTZ DEFAULT NOW()
)`)
	if err != nil {
		return fmt.Errorf("create satellites table: %w", err)
	}
	return nil
}

// upsertSatellites inserts or updates each satellite record in the database.
// Returns the number of rows affected and the count of INDIA satellites upserted.
func upsertSatellites(db *sql.DB, sats []Satellite) (int, int, error) {
	const query = `
INSERT INTO satellites (norad_id, name, tle_line1, tle_line2, epoch, country, category)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (norad_id) DO UPDATE SET
  name       = EXCLUDED.name,
  tle_line1  = EXCLUDED.tle_line1,
  tle_line2  = EXCLUDED.tle_line2,
  epoch      = EXCLUDED.epoch,
  updated_at = NOW()`

	stmt, err := db.Prepare(query)
	if err != nil {
		return 0, 0, fmt.Errorf("prepare upsert: %w", err)
	}
	defer stmt.Close()

	upserted := 0
	indiaCount := 0

	for _, s := range sats {
		var epochArg interface{}
		if !s.Epoch.IsZero() {
			epochArg = s.Epoch
		} else {
			epochArg = nil
		}

		_, err := stmt.Exec(s.NORADId, s.Name, s.TLELine1, s.TLELine2, epochArg, s.Country, s.Category)
		if err != nil {
			log.Printf("warning: upsert failed for NORAD %d (%s): %v", s.NORADId, s.Name, err)
			continue
		}
		upserted++
		if s.Country == "INDIA" {
			indiaCount++
		}
	}

	return upserted, indiaCount, nil
}

func main() {
	dbURL := getEnv("DATABASE_URL", defaultDatabaseURL)
	tleURL := getEnv("TLE_URL", defaultTLEURL)

	log.Printf("tinai-tle: starting TLE ingest")
	log.Printf("  TLE source : %s", tleURL)
	log.Printf("  database   : %s", maskPassword(dbURL))

	// Step 1: Fetch TLE data
	log.Printf("fetching TLE data...")
	body, err := fetchTLE(tleURL)
	if err != nil {
		log.Fatalf("fetch TLE: %v", err)
	}

	// Step 2: Parse TLE text
	sats, err := parseTLEText(body)
	if err != nil {
		log.Fatalf("parse TLE: %v", err)
	}
	log.Printf("fetched and parsed %d satellites", len(sats))

	// Step 3: Connect to PostgreSQL
	db, err := sql.Open("postgres", dbURL)
	if err != nil {
		log.Fatalf("sql.Open: %v", err)
	}
	defer db.Close()

	// Retry connection up to 5 times with backoff (useful in CronJob cold-start scenarios)
	const maxRetries = 5
	for i := 1; i <= maxRetries; i++ {
		if err = db.Ping(); err == nil {
			break
		}
		if i == maxRetries {
			log.Fatalf("database ping failed after %d attempts: %v", maxRetries, err)
		}
		wait := time.Duration(math.Pow(2, float64(i))) * time.Second
		log.Printf("database not ready (attempt %d/%d), retrying in %v...", i, maxRetries, wait)
		time.Sleep(wait)
	}
	log.Printf("connected to database")

	// Step 4: Ensure schema
	if err := ensureSchema(db); err != nil {
		log.Fatalf("ensure schema: %v", err)
	}
	log.Printf("schema verified")

	// Step 5: Upsert satellites
	upserted, indiaCount, err := upsertSatellites(db, sats)
	if err != nil {
		log.Fatalf("upsert satellites: %v", err)
	}

	// Step 6: Summary
	log.Printf("--- ingest summary ---")
	log.Printf("  total fetched : %d", len(sats))
	log.Printf("  upserted      : %d", upserted)
	log.Printf("  INDIA sats    : %d", indiaCount)
	log.Printf("tinai-tle: done")
}

// maskPassword replaces the password in a PostgreSQL DSN with asterisks for safe logging.
func maskPassword(dsn string) string {
	// Format: postgresql://user:password@host/db?...
	atIdx := strings.LastIndex(dsn, "@")
	if atIdx < 0 {
		return dsn
	}
	schemeEnd := strings.Index(dsn, "://")
	if schemeEnd < 0 {
		return dsn
	}
	userInfo := dsn[schemeEnd+3 : atIdx]
	colonIdx := strings.Index(userInfo, ":")
	if colonIdx < 0 {
		return dsn
	}
	user := userInfo[:colonIdx]
	return dsn[:schemeEnd+3] + user + ":****@" + dsn[atIdx+1:]
}
