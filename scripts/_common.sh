#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
PID_FILE="${LOG_DIR}/hedgehub.pid"
APP_LOG="${LOG_DIR}/hedgehub.log"
DB_MODE_FILE="${LOG_DIR}/db.mode"
DEFAULT_PORT="${PORT:-8787}"

mkdir -p "${LOG_DIR}"

load_env_files() {
  local env_file
  for env_file in "${ROOT_DIR}/.env.local" "${ROOT_DIR}/.env"; do
    if [[ -f "${env_file}" ]]; then
      set -a
      # shellcheck disable=SC1090
      source "${env_file}"
      set +a
    fi
  done
}

read_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    tr -d '[:space:]' < "${PID_FILE}"
  fi
}

is_running() {
  local pid="${1:-}"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

clear_stale_pid() {
  local pid
  pid="$(read_pid || true)"

  if [[ -n "${pid}" ]] && ! is_running "${pid}"; then
    rm -f "${PID_FILE}"
  fi
}

require_dependencies() {
  if [[ ! -d "${ROOT_DIR}/node_modules" ]]; then
    echo "Dependencies are missing. Run 'npm install' first." >&2
    exit 1
  fi
}

compose_cmd() {
  docker compose "$@"
}

postgres_database_url() {
  local host="${POSTGRES_HOST:-localhost}"
  local port="${POSTGRES_PORT:-5432}"
  local database="${POSTGRES_DB:-optionsdb}"
  local user="${POSTGRES_USER:-postgres}"
  local password="${POSTGRES_PASSWORD:-postgres}"
  printf 'postgresql://%s:%s@%s:%s/%s' "${user}" "${password}" "${host}" "${port}" "${database}"
}

record_db_mode() {
  printf '%s\n' "${1:-sqlite}" > "${DB_MODE_FILE}"
}

read_db_mode() {
  if [[ -f "${DB_MODE_FILE}" ]]; then
    tr -d '[:space:]' < "${DB_MODE_FILE}"
  else
    printf 'sqlite\n'
  fi
}

wait_for_postgres() {
  local mode="${1:-docker}"

  if [[ "${mode}" == "local" ]]; then
    command -v pg_isready >/dev/null 2>&1 || {
      echo "pg_isready is required for --local-db. Install PostgreSQL client tools first." >&2
      exit 1
    }

    until pg_isready \
      -h "${POSTGRES_HOST:-localhost}" \
      -p "${POSTGRES_PORT:-5432}" \
      -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; do
      echo "[DB] Waiting for PostgreSQL..."
      sleep 2
    done
    return
  fi

  until compose_cmd exec -T postgres pg_isready \
    -h localhost \
    -p 5432 \
    -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; do
    echo "[DB] Waiting for PostgreSQL container..."
    sleep 2
  done
}

check_timescaledb() {
  local mode="${1:-docker}"
  local sql="CREATE EXTENSION IF NOT EXISTS timescaledb;"

  if [[ "${mode}" == "local" ]]; then
    command -v psql >/dev/null 2>&1 || {
      echo "psql is required for --local-db. Install PostgreSQL client tools first." >&2
      exit 1
    }
    PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" \
      psql "$(postgres_database_url)" -v ON_ERROR_STOP=1 -c "${sql}" >/dev/null
  else
    compose_cmd exec -T postgres psql \
      -U "${POSTGRES_USER:-postgres}" \
      -d "${POSTGRES_DB:-optionsdb}" \
      -v ON_ERROR_STOP=1 \
      -c "${sql}" >/dev/null
  fi
  echo "[DB] TimescaleDB extension verified"
}

run_db_init() {
  local mode="${1:-docker}"
  local sql_file

  echo "[DB] Running migrations"
  for sql_file in "${ROOT_DIR}"/db/init/*.sql; do
    [[ -f "${sql_file}" ]] || continue
    if [[ "${mode}" == "local" ]]; then
      PGPASSWORD="${POSTGRES_PASSWORD:-postgres}" \
        psql "$(postgres_database_url)" -v ON_ERROR_STOP=1 -f "${sql_file}" >/dev/null
    else
      compose_cmd exec -T postgres psql \
        -U "${POSTGRES_USER:-postgres}" \
        -d "${POSTGRES_DB:-optionsdb}" \
        -v ON_ERROR_STOP=1 \
        -f "/docker-entrypoint-initdb.d/$(basename "${sql_file}")" >/dev/null
    fi
  done
  echo "[DB] Schema initialized"
}
