FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /usage-aggregator .

FROM alpine:3.19
COPY --from=builder /usage-aggregator /usage-aggregator
CMD ["/usage-aggregator"]
