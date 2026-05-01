# ── Stage 1: Build ──────────────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

WORKDIR /src

# Cache module downloads separately from source changes.
COPY go.mod go.sum ./
RUN go mod download

# Copy all source.
COPY . .

# Build a statically-linked binary.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/tinai-gateway .

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# gcr.io/distroless/static-debian12 has no shell and no package manager —
# minimal attack surface.
FROM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="tinai-gateway" \
      org.opencontainers.image.description="Tinai AI Gateway — managed proxy for AI model calls" \
      org.opencontainers.image.vendor="Tinai" \
      org.opencontainers.image.licenses="Proprietary"

COPY --from=builder /out/tinai-gateway /tinai-gateway

EXPOSE 3005

USER nonroot:nonroot

ENTRYPOINT ["/tinai-gateway"]
