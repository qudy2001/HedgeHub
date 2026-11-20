#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

load_env_files
clear_stale_pid

current_pid="$(read_pid || true)"
if [[ -z "${current_pid}" ]]; then
  echo "HedgeHub is not running."
elif ! is_running "${current_pid}"; then
  rm -f "${PID_FILE}"
  echo "Removed stale PID file."
else
  echo "Stopping HedgeHub PID ${current_pid}..."
  kill "${current_pid}"

  for _ in {1..10}; do
    if ! is_running "${current_pid}"; then
      rm -f "${PID_FILE}"
      echo "HedgeHub stopped."
      break
    fi
    sleep 1
  done

  if is_running "${current_pid}"; then
    echo "Process did not exit after 10 seconds. Sending SIGKILL..."
    kill -9 "${current_pid}" 2>/dev/null || true
    rm -f "${PID_FILE}"
    echo "HedgeHub stopped."
  fi
fi

if [[ "${DB_TYPE:-sqlite}" == "postgres" ]] && [[ "$(read_db_mode)" == "docker" ]]; then
  echo "Stopping PostgreSQL container without removing data..."
  compose_cmd stop postgres >/dev/null
fi
