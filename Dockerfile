# Freebuff Proxy — Docker image
# Zero-dependency Node.js app; slim alpine base.

FROM node:20-alpine

WORKDIR /app

# No package install needed (zero deps), but keep metadata for healthchecks
COPY package.json ./
COPY server.js ./
COPY config.example.json ./config.example.json

# Config is mounted at runtime via volume; provide default if absent
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/healthz || exit 1

CMD ["node", "server.js"]
