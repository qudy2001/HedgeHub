#!/usr/bin/env bash
set -euo pipefail

IBKR_ENABLED="${HEDGEHUB_START_IBKR_GATEWAY:-true}"
IBKR_GATEWAY_PORT="${IBKR_GATEWAY_PORT:-5001}"
APP_CMD=(node server/index.js)
gateway_pid=""
app_pid=""

shutdown() {
  trap - INT TERM

  if [[ -n "${app_pid}" ]] && kill -0 "${app_pid}" 2>/dev/null; then
    kill -TERM "${app_pid}" 2>/dev/null || true
  fi

  if [[ -n "${gateway_pid}" ]] && kill -0 "${gateway_pid}" 2>/dev/null; then
    kill -TERM "${gateway_pid}" 2>/dev/null || true
  fi

  wait "${app_pid}" 2>/dev/null || true
  wait "${gateway_pid}" 2>/dev/null || true
}

trap shutdown INT TERM

if [[ "${IBKR_ENABLED,,}" != "false" ]]; then
  export IBKR_GATEWAY_PORT
  export IBKR_CP_BASE_URL="${IBKR_CP_BASE_URL:-https://127.0.0.1:${IBKR_GATEWAY_PORT}/v1/api}"

  /usr/local/bin/ibkr-gateway-entrypoint &
  gateway_pid=$!

  startup_deadline=$((SECONDS + ${IBKR_GATEWAY_STARTUP_TIMEOUT_SECS:-45}))
  while (( SECONDS < startup_deadline )); do
    if curl -ksS --connect-timeout 2 --max-time 5 "https://127.0.0.1:${IBKR_GATEWAY_PORT}/" >/dev/null 2>&1; then
      break
    fi

    if ! kill -0 "${gateway_pid}" 2>/dev/null; then
      wait "${gateway_pid}"
      exit $?
    fi

    sleep 1
  done
fi

"${APP_CMD[@]}" &
app_pid=$!

if [[ -z "${gateway_pid}" ]]; then
  wait "${app_pid}"
  exit $?
fi

wait -n "${app_pid}" "${gateway_pid}"
exit_code=$?

if kill -0 "${app_pid}" 2>/dev/null; then
  echo "IBKR Client Portal Gateway exited. Stopping HedgeHub."
  kill -TERM "${app_pid}" 2>/dev/null || true
  wait "${app_pid}" 2>/dev/null || true
else
  kill -TERM "${gateway_pid}" 2>/dev/null || true
  wait "${gateway_pid}" 2>/dev/null || true
fi

exit "${exit_code}"
