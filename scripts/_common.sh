#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
PID_FILE="${LOG_DIR}/hedgehub.pid"
APP_LOG="${LOG_DIR}/hedgehub.log"
DEFAULT_PORT="${PORT:-8787}"

mkdir -p "${LOG_DIR}"

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
