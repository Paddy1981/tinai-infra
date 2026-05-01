FROM golang:1.22-alpine AS builder
RUN apk add --no-cache ca-certificates git
WORKDIR /app
COPY . .
RUN go mod tidy && go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -ldflags="-w -s" -o forge-server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=builder /app/forge-server .
COPY --from=builder /app/internal/db/schema.sql ./schema.sql
RUN addgroup -g 1000 forge && adduser -D -u 1000 -G forge forge
RUN chown -R forge:forge /app
USER forge
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3     CMD wget --no-verbose --tries=1 --spider http://localhost:8090/health || exit 1
EXPOSE 8090
ENTRYPOINT ["./forge-server"]
