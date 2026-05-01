# --- build stage ---
FROM golang:1.22-alpine AS builder

WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/provisioner .

# --- runtime stage (distroless) ---
FROM gcr.io/distroless/static:nonroot

COPY --from=builder /out/provisioner /provisioner

USER nonroot:nonroot
ENTRYPOINT ["/provisioner"]
