FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /tle-ingest .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /tle-ingest /tle-ingest
CMD ["/tle-ingest"]
