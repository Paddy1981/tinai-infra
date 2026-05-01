FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production

FROM node:20-alpine
RUN apk add --no-cache tini curl
RUN addgroup -g 1001 tinai && adduser -D -u 1001 -G tinai tinai
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER tinai
ENTRYPOINT ["/sbin/tini", "--"]
