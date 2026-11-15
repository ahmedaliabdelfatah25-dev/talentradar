# syntax=docker/dockerfile:1
# Talent Radar — one image serves the web application and the REST API on a single port.

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build -w web && npm run build -w server
RUN npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web/dist
# DejaVu fonts let the PDF report render accented and non-Latin names.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run automatically at start (idempotent, guarded by an advisory lock).
CMD ["node", "server/dist/index.js"]
