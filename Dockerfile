# ── Build stage ──────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Don't run as root
RUN addgroup -S nova && adduser -S nova -G nova

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Remove dev/config files not needed at runtime
RUN rm -f .env.example fly.toml railway.json Dockerfile .dockerignore

USER nova

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
