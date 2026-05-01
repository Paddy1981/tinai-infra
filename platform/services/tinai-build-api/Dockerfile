FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /build-api ./cmd/server

FROM scratch
COPY --from=builder /build-api /build-api
ENTRYPOINT ["/build-api"]
