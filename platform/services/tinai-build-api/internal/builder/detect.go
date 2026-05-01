package builder

import (
	"fmt"
	"strings"
)

// AppType represents the detected application runtime.
type AppType string

const (
	AppTypeDockerfile AppType = "dockerfile"
	AppTypeNodeJS     AppType = "nodejs"
	AppTypeGo         AppType = "go"
	AppTypePython     AppType = "python"
	AppTypeRuby       AppType = "ruby"
	AppTypeJava       AppType = "java"
	AppTypeStatic     AppType = "static"
	AppTypeUnknown    AppType = "unknown"
)

// DetectionResult holds the detected app type and the build configuration derived from it.
type DetectionResult struct {
	Type       AppType
	BaseImage  string // suggested base image
	BuildCmd   string // build command to run (may be empty)
	StartCmd   string // start/run command
	Port       int    // default listening port
	InstallCmd string // dependency install command
}

// DetectAppType inspects the repository file list to determine the build strategy.
// Priority order: Dockerfile > go.mod > package.json > requirements.txt/pyproject.toml >
// Gemfile > pom.xml/build.gradle > index.html > unknown.
func DetectAppType(files []string) DetectionResult {
	fileSet := make(map[string]bool, len(files))
	for _, f := range files {
		fileSet[strings.ToLower(f)] = true
	}

	switch {
	case fileSet["dockerfile"]:
		return DetectionResult{Type: AppTypeDockerfile}

	case fileSet["go.mod"]:
		return DetectionResult{
			Type:       AppTypeGo,
			BaseImage:  "golang:1.21-alpine",
			BuildCmd:   "go build -o /app/server .",
			StartCmd:   "/app/server",
			Port:       8080,
			InstallCmd: "go mod download",
		}

	case fileSet["package.json"]:
		// Next.js detection — check for any common next.config filename variant.
		if fileSet["next.config.js"] || fileSet["next.config.ts"] || fileSet["next.config.mjs"] {
			return DetectionResult{
				Type:       AppTypeNodeJS,
				BaseImage:  "node:20-alpine",
				InstallCmd: "npm ci",
				BuildCmd:   "npm run build",
				StartCmd:   "npm start",
				Port:       3000,
			}
		}
		return DetectionResult{
			Type:       AppTypeNodeJS,
			BaseImage:  "node:20-alpine",
			InstallCmd: "npm ci",
			BuildCmd:   "",
			StartCmd:   "node index.js",
			Port:       3000,
		}

	case fileSet["requirements.txt"] || fileSet["pyproject.toml"]:
		return DetectionResult{
			Type:       AppTypePython,
			BaseImage:  "python:3.12-slim",
			InstallCmd: "pip install -r requirements.txt",
			StartCmd:   "python app.py",
			Port:       5000,
		}

	case fileSet["gemfile"]:
		return DetectionResult{
			Type:       AppTypeRuby,
			BaseImage:  "ruby:3.3-slim",
			InstallCmd: "bundle install",
			StartCmd:   "bundle exec ruby app.rb",
			Port:       4567,
		}

	case fileSet["pom.xml"] || fileSet["build.gradle"]:
		return DetectionResult{
			Type:      AppTypeJava,
			BaseImage: "eclipse-temurin:21-jdk-alpine",
			BuildCmd:  "mvn package -q",
			StartCmd:  "java -jar target/*.jar",
			Port:      8080,
		}

	case fileSet["index.html"]:
		return DetectionResult{
			Type:      AppTypeStatic,
			BaseImage: "nginx:alpine",
			Port:      80,
		}
	}

	return DetectionResult{Type: AppTypeUnknown}
}

// GenerateDockerfile returns a multi-stage Dockerfile string for the detected app type.
// Returns an empty string for AppTypeDockerfile (already has one) and AppTypeUnknown.
func GenerateDockerfile(result DetectionResult) string {
	switch result.Type {
	case AppTypeGo:
		return `FROM golang:1.21-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /app/server .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=builder /app/server /app/server
EXPOSE 8080
CMD ["/app/server"]`

	case AppTypeNodeJS:
		buildLines := ""
		if result.BuildCmd != "" {
			buildLines = "RUN " + result.BuildCmd + "\n"
		}
		return fmt.Sprintf(`FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
%sEXPOSE %d
CMD [%s]`, buildLines, result.Port, formatCMD(result.StartCmd))

	case AppTypePython:
		return fmt.Sprintf(`FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE %d
CMD ["python", "app.py"]`, result.Port)

	case AppTypeRuby:
		return fmt.Sprintf(`FROM ruby:3.3-slim
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install
COPY . .
EXPOSE %d
CMD ["bundle", "exec", "ruby", "app.rb"]`, result.Port)

	case AppTypeJava:
		return `FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /app
COPY . .
RUN mvn package -q

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]`

	case AppTypeStatic:
		return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`
	}

	// AppTypeDockerfile and AppTypeUnknown: nothing to generate.
	return ""
}

// formatCMD converts a shell command string into a JSON-array CMD literal
// suitable for embedding inside a Dockerfile CMD instruction.
// Example: "node index.js" → `"node", "index.js"`
func formatCMD(cmd string) string {
	parts := strings.Fields(cmd)
	quoted := make([]string, len(parts))
	for i, p := range parts {
		quoted[i] = fmt.Sprintf("%q", p)
	}
	return strings.Join(quoted, ", ")
}
