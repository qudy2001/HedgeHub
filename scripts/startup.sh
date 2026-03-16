#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

clear_stale_pid

current_pid="$(read_pid || true)"
if is_running "${current_pid:-}"; then
  echo "HedgeHub is already running with PID ${current_pid}."
  echo "Log: ${APP_LOG}"
  exit 0
fi

require_dependencies

cd "${ROOT_DIR}"

echo "Building production assets..."
npm run build

echo "Starting HedgeHub on port ${DEFAULT_PORT}..."
nohup env NODE_ENV=production PORT="${DEFAULT_PORT}" node server/index.js >> "${APP_LOG}" 2>&1 < /dev/null &
app_pid=$!
disown "${app_pid}" 2>/dev/null || true
echo "${app_pid}" > "${PID_FILE}"

sleep 2

if ! is_running "${app_pid}"; then
  echo "HedgeHub failed to start. Recent log output:" >&2
  tail -n 40 "${APP_LOG}" >&2 || true
  rm -f "${PID_FILE}"
  exit 1
fi

echo "HedgeHub started with PID ${app_pid}."
echo "App: http://localhost:${DEFAULT_PORT}"
echo "Log: ${APP_LOG}"
