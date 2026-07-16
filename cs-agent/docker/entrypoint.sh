#!/bin/bash
set -euo pipefail

export POSTGRES_USER="${POSTGRES_USER:-csagent}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-database123456}"
export POSTGRES_DB="${POSTGRES_DB:-csagent}"
export PGDATA="${PGDATA:-/var/lib/postgresql/data}"
export PORT="${PORT:-8080}"
export BACKEND_PORT="${BACKEND_PORT:-3000}"

PG_VERSION="$(ls /usr/lib/postgresql/ | sort -rn | head -1)"
PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"
export PATH="${PG_BIN}:${PATH}"

run_as_postgres() {
  su postgres -c "export PATH=${PG_BIN}:\$PATH; $*"
}

echo "[entrypoint] Starting CS Agent (PostgreSQL ${PG_VERSION} + API + Web)..."

mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "[entrypoint] Initializing PostgreSQL data directory..."
  run_as_postgres "initdb -D '$PGDATA' --auth-host=trust --auth-local=trust"

  echo "[entrypoint] Starting temporary PostgreSQL for bootstrap..."
  run_as_postgres "pg_ctl -D '$PGDATA' -o \"-c listen_addresses='127.0.0.1'\" -w start"

  run_as_postgres "psql -v ON_ERROR_STOP=1" <<-EOSQL
    CREATE USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}' CREATEDB;
    CREATE DATABASE ${POSTGRES_DB} OWNER ${POSTGRES_USER};
EOSQL

  run_as_postgres "pg_ctl -D '$PGDATA' -m fast -w stop"
fi

echo "[entrypoint] Starting PostgreSQL..."
run_as_postgres "pg_ctl -D '$PGDATA' -o \"-c listen_addresses='127.0.0.1'\" -w start"

until run_as_postgres "pg_isready -h 127.0.0.1 -p 5432" >/dev/null 2>&1; do
  echo "[entrypoint] Waiting for PostgreSQL..."
  sleep 1
done

export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"
export POSTGRES_HOST="127.0.0.1"
export POSTGRES_PORT="5432"

echo "[entrypoint] Starting Node.js backend on port ${BACKEND_PORT}..."
cd /app/backend
PORT="${BACKEND_PORT}" node server.js &
BACKEND_PID=$!

for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${BACKEND_PORT}/api/v1/health" >/dev/null 2>&1; then
    echo "[entrypoint] Backend is healthy."
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "[entrypoint] Backend process exited unexpectedly."
    exit 1
  fi
  sleep 1
done

echo "[entrypoint] Starting nginx on port ${PORT}..."
envsubst '${PORT}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

trap 'echo "[entrypoint] Shutting down..."; kill $BACKEND_PID 2>/dev/null || true; run_as_postgres "pg_ctl -D \"$PGDATA\" -m fast -w stop" 2>/dev/null || true' SIGTERM SIGINT

nginx -g 'daemon off;' &
NGINX_PID=$!

wait -n "$BACKEND_PID" "$NGINX_PID"
