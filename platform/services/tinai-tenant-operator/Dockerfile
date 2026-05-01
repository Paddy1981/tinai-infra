FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /tenant-operator ./cmd/

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /tenant-operator /tenant-operator
USER nonroot:nonroot
ENTRYPOINT ["/tenant-operator"]
