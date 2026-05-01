# Multi-stage build — keeps final image lean
# Base: node:20-alpine (~50 MB vs ~1 GB for full node)

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --production

FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for security (K8s PSS restricted profile)
RUN addgroup -g 1001 -S tinai && adduser -u 1001 -S tinai -G tinai

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY config/ ./config/
COPY src/ ./src/

# Use tini as PID 1 for proper signal handling
# (avoids zombie processes and ensures SIGTERM propagates)
RUN apk add --no-cache tini

RUN chown -R tinai:tinai /app
USER tinai

# Health server port
EXPOSE 3100

# Graceful shutdown timeout (K8s terminationGracePeriodSeconds should be >= this)
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]

# Labels for Harbor registry
LABEL org.opencontainers.image.source="https://gitea.tinai.cloud/tinai/metering-bridge"
LABEL org.opencontainers.image.description="Tinai usage metering bridge — Prometheus to Lago"
LABEL org.opencontainers.image.vendor="Tinai / Larun Engineering LLP"
