FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /realtime .

FROM gcr.io/distroless/static:nonroot
COPY --from=builder /realtime /realtime
EXPOSE 3003
ENTRYPOINT ["/realtime"]
