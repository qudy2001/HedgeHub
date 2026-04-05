#!/usr/bin/env bash
set -euo pipefail

GATEWAY_DIR="${IBKR_GATEWAY_DIR:-/opt/ibkr/clientportal.gw}"
CONF_ARG="${IBKR_GATEWAY_CONF_PATH:-root/conf.yaml}"
LISTEN_PORT="${IBKR_GATEWAY_PORT:-5000}"
RUN_SCRIPT="${GATEWAY_DIR}/bin/run.sh"
GENERATED_CONF_ARG="${IBKR_GATEWAY_GENERATED_CONF_PATH:-root/conf.docker.yaml}"

if [[ "${CONF_ARG}" = /* ]]; then
  CONF_SOURCE_PATH="${CONF_ARG}"
else
  CONF_SOURCE_PATH="${GATEWAY_DIR}/${CONF_ARG}"
fi

if [[ "${GENERATED_CONF_ARG}" = /* ]]; then
  GENERATED_CONF_PATH="${GENERATED_CONF_ARG}"
else
  GENERATED_CONF_PATH="${GATEWAY_DIR}/${GENERATED_CONF_ARG}"
fi

if [[ ! -d "${GATEWAY_DIR}" ]]; then
  echo "IBKR gateway directory not found at ${GATEWAY_DIR}."
  echo "Mount the unzipped clientportal.gw folder into the container before starting the service."
  exit 1
fi

if [[ ! -f "${CONF_SOURCE_PATH}" ]]; then
  echo "IBKR gateway config not found at ${CONF_SOURCE_PATH}."
  echo "Expected to find root/conf.yaml inside the mounted clientportal.gw bundle."
  exit 1
fi

if [[ ! -f "${RUN_SCRIPT}" ]]; then
  echo "IBKR gateway launcher not found at ${RUN_SCRIPT}."
  echo "Expected to find bin/run.sh inside the mounted clientportal.gw bundle."
  exit 1
fi

chmod +x "${RUN_SCRIPT}"

mkdir -p "$(dirname "${GENERATED_CONF_PATH}")"

# Generate a clean config for Docker startup instead of mutating the mounted
# source file in place. This repairs earlier malformed placements of
# listenPort and keeps the vendor bundle closer to its original state.
awk -v port="${LISTEN_PORT}" '
  BEGIN {
    inserted = 0
    top_indent = ""
  }
  {
    sub(/\r$/, "", $0)
    if ($0 ~ /^[[:space:]]*(---|\.{3})[[:space:]]*$/) {
      next
    }
    if ($0 ~ /^[[:space:]]*listenPort:[[:space:]]*/) {
      next
    }
    if (top_indent == "" && $0 ~ /^[[:space:]]*[^[:space:]#][^:]*:[[:space:]]*/) {
      match($0, /^[[:space:]]*/)
      top_indent = substr($0, RSTART, RLENGTH)
    }
    print
    if (!inserted && $0 ~ /^[[:space:]]*proxyRemoteHost:[[:space:]]*/) {
      match($0, /^[[:space:]]*/)
      print substr($0, RSTART, RLENGTH) "listenPort: " port
      inserted = 1
    }
  }
  END {
    if (!inserted) {
      print top_indent "listenPort: " port
    }
  }
' "${CONF_SOURCE_PATH}" > "${GENERATED_CONF_PATH}"

cd "${GATEWAY_DIR}"

echo "Starting IBKR Client Portal Gateway from ${GATEWAY_DIR} on port ${LISTEN_PORT}"
echo "Using source config ${CONF_ARG} and generated config ${GENERATED_CONF_ARG}"
exec "${RUN_SCRIPT}" "${GENERATED_CONF_ARG}"
