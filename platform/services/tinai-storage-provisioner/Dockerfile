FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /storage-provisioner .

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /storage-provisioner /storage-provisioner
USER nonroot:nonroot
ENTRYPOINT ["/storage-provisioner"]
