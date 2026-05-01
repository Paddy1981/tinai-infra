package detect

import "fmt"

// GenerateDockerfile returns an optimised multi-stage Dockerfile string for
// the given BuildPlan. Returns an empty string for runtime "docker" (the repo
// already contains a Dockerfile) and "unknown".
func GenerateDockerfile(plan BuildPlan) string {
	switch plan.Runtime {
	case "node":
		return generateNodeDockerfile(plan)
	case "python":
		return generatePythonDockerfile(plan)
	case "go":
		return generateGoDockerfile(plan)
	case "static":
		return generateStaticDockerfile(plan)
	}
	// "docker" and "unknown" — nothing to generate.
	return ""
}

// ---------- per-runtime generators ----------

func generateNodeDockerfile(plan BuildPlan) string {
	switch plan.Framework {
	case "nextjs":
		return generateNextjsDockerfile()
	case "react", "vue":
		return generateSPADockerfile(plan)
	}
	// Plain Node
	return generatePlainNodeDockerfile(plan)
}

// generateNextjsDockerfile creates a production-ready Next.js Dockerfile that
// relies on `output: "standalone"` in next.config.js.
func generateNextjsDockerfile() string {
	return `# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]`
}

// generateSPADockerfile generates a React / Vue SPA Dockerfile that builds
// with npm and serves the static output via nginx.
func generateSPADockerfile(plan BuildPlan) string {
	buildCmd := plan.BuildCmd
	if buildCmd == "" {
		buildCmd = "npm run build"
	}
	return fmt.Sprintf(`# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN %s

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`, buildCmd)
}

// generatePlainNodeDockerfile creates a single-stage Dockerfile for a plain
// Node.js application (no build step required unless BuildCmd is set).
func generatePlainNodeDockerfile(plan BuildPlan) string {
	buildSection := ""
	if plan.BuildCmd != "" {
		buildSection = "RUN " + plan.BuildCmd + "\n"
	}
	startCmd := plan.StartCmd
	if startCmd == "" {
		startCmd = "node index.js"
	}
	return fmt.Sprintf(`# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
%sEXPOSE %d
CMD [%s]`, buildSection, plan.Port, formatCMD(startCmd))
}

func generatePythonDockerfile(plan BuildPlan) string {
	switch plan.Framework {
	case "fastapi":
		return generateFastAPIDockerfile()
	case "django":
		return generateDjangoDockerfile()
	case "flask":
		return generateFlaskDockerfile()
	}
	// Generic Python
	startCmd := plan.StartCmd
	if startCmd == "" {
		startCmd = "python main.py"
	}
	return fmt.Sprintf(`# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
COPY requirements*.txt pyproject.toml* ./
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || \
    pip install --no-cache-dir .
COPY . .
EXPOSE %d
CMD [%s]`, plan.Port, formatCMD(startCmd))
}

func generateFastAPIDockerfile() string {
	return `# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]`
}

func generateDjangoDockerfile() string {
	return `# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN python manage.py collectstatic --noinput || true
EXPOSE 8000
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--workers", "2"]`
}

func generateFlaskDockerfile() string {
	return `# syntax=docker/dockerfile:1
FROM python:3.12-slim
WORKDIR /app
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:8000"]`
}

func generateGoDockerfile(plan BuildPlan) string {
	return `# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/server .

FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata
WORKDIR /app
COPY --from=builder /app/server ./server
EXPOSE 8080
CMD ["./server"]`
}

func generateStaticDockerfile(_ BuildPlan) string {
	return `# syntax=docker/dockerfile:1
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`
}
