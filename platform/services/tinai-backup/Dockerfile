FROM golang:1.21-alpine AS builder
RUN apk add --no-cache postgresql-client
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /tinai-backup .

FROM alpine:latest
RUN apk --no-cache add ca-certificates postgresql-client
COPY --from=builder /tinai-backup /tinai-backup
ENTRYPOINT ["/tinai-backup"]
