#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

clear_stale_pid

current_pid="$(read_pid || true)"
if [[ -z "${current_pid}" ]]; then
  echo "HedgeHub is not running."
  exit 0
fi

if ! is_running "${current_pid}"; then
  rm -f "${PID_FILE}"
  echo "Removed stale PID file."
  exit 0
fi

echo "Stopping HedgeHub PID ${current_pid}..."
kill "${current_pid}"

for _ in {1..10}; do
  if ! is_running "${current_pid}"; then
    rm -f "${PID_FILE}"
    echo "HedgeHub stopped."
    exit 0
  fi
  sleep 1
done

echo "Process did not exit after 10 seconds. Sending SIGKILL..."
kill -9 "${current_pid}" 2>/dev/null || true
rm -f "${PID_FILE}"
echo "HedgeHub stopped."
