#!/usr/bin/env bash
# Builds and starts the Talent Radar demo inside a GitHub Codespace, then prints its HTTPS address.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=.devcontainer/.demo.env

# The database password is generated on first start and never committed.
if [ ! -f "$ENV_FILE" ]; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# The public HTTPS address of port 8080 in this codespace (used for same-origin checks).
if [ -n "${CODESPACE_NAME:-}" ]; then
  export APP_URL="https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
fi

echo "Waiting for Docker…"
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done

echo "Building and starting Talent Radar (the first start takes a few minutes)…"
docker compose -f .devcontainer/demo-compose.yml --env-file "$ENV_FILE" up -d --build

echo "Waiting for the health check…"
for _ in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then
    echo
    echo "Talent Radar is running with fictional demonstration data."
    echo "Open: ${APP_URL:-http://localhost:8080}"
    echo "(Ports tab → Talent Radar → globe icon opens the same address.)"
    exit 0
  fi
  sleep 2
done
echo "The application did not become healthy. Logs:" >&2
docker compose -f .devcontainer/demo-compose.yml --env-file "$ENV_FILE" logs --tail 60 app >&2
exit 1
