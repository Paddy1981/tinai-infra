FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /functions .

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /functions /functions
EXPOSE 3004
ENTRYPOINT ["/functions"]
