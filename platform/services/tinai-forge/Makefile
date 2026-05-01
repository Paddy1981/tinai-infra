.PHONY: build test run clean help

# Variables
BINARY_NAME=forge-server
GO_VERSION?=1.22
DOCKER_IMAGE?=tinai/forge
DOCKER_TAG?=latest

help:
	@echo "TinAI Forge - Build targets:"
	@echo "  make build       - Build the server binary"
	@echo "  make test        - Run tests"
	@echo "  make run         - Run the server locally"
	@echo "  make docker      - Build Docker image"
	@echo "  make clean       - Clean build artifacts"
	@echo "  make lint        - Run linter"
	@echo "  make fmt         - Format code"

build:
	@echo "Building $(BINARY_NAME)..."
	CGO_ENABLED=0 GOOS=linux go build -o bin/$(BINARY_NAME) ./cmd/server

test:
	@echo "Running tests..."
	go test -v -race -cover ./...

run: build
	@echo "Running $(BINARY_NAME)..."
	./bin/$(BINARY_NAME)

docker: build
	@echo "Building Docker image $(DOCKER_IMAGE):$(DOCKER_TAG)..."
	docker build -t $(DOCKER_IMAGE):$(DOCKER_TAG) .
	@echo "Image built: $(DOCKER_IMAGE):$(DOCKER_TAG)"

clean:
	@echo "Cleaning build artifacts..."
	rm -rf bin/
	rm -f $(BINARY_NAME)
	go clean

lint:
	@echo "Running linter..."
	golangci-lint run ./...

fmt:
	@echo "Formatting code..."
	go fmt ./...
	goimports -w .

vet:
	@echo "Running go vet..."
	go vet ./...

mod-download:
	@echo "Downloading dependencies..."
	go mod download
	go mod verify

mod-tidy:
	@echo "Tidying dependencies..."
	go mod tidy

all: clean lint test build
	@echo "Build complete!"
