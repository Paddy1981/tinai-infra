FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod main.go ./
RUN CGO_ENABLED=0 go build -o tinai-edge-agent .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/tinai-edge-agent /usr/local/bin/
USER nobody
ENTRYPOINT ["tinai-edge-agent"]
