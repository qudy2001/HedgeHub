#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/qudy2001/hedgehub-livedata-ibkr}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER_NAME="${BUILDER_NAME:-codex-ghcr}"
DOCKERFILE_PATH="${DOCKERFILE_PATH:-deploy/hedgehub-ibkr/Dockerfile}"
VERIFY_AFTER_PUSH="${VERIFY_AFTER_PUSH:-true}"
VERIFY_CONTAINER_NAME="${VERIFY_CONTAINER_NAME:-hedgehub-ibkr-verify}"
PROGRESS_MODE="${PROGRESS_MODE:-plain}"

IMAGE_REF=""
DOCKERFILE_ABS=""
PUBLISHED_DIGEST=""

usage() {
  cat <<'EOF'
Usage: ./scripts/publish-ibkr-image.sh [options]

Builds and pushes the embedded IBKR image to GHCR.

Options:
  --image <repo>        Image repository to publish.
  --tag <tag>           Image tag to publish.
  --platforms <list>    Buildx platform list.
  --builder <name>      Buildx builder name.
  --dockerfile <path>   Dockerfile path relative to repo root.
  --no-verify           Skip the local /api/health smoke test.
  --verify              Force the local smoke test on.
  -h, --help            Show this help message.

Environment overrides:
  IMAGE_REPO
  IMAGE_TAG
  PLATFORMS
  BUILDER_NAME
  DOCKERFILE_PATH
  VERIFY_AFTER_PUSH
  VERIFY_CONTAINER_NAME
  PROGRESS_MODE
EOF
}

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

die() {
  echo "Error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

cleanup_verify_container() {
  docker rm -f "${VERIFY_CONTAINER_NAME}" >/dev/null 2>&1 || true
}

show_git_context() {
  local branch commit

  if ! git -C "${ROOT_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return
  fi

  branch="$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
  commit="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo "unknown")"

  log "Git context: ${branch} @ ${commit}"

  if ! git -C "${ROOT_DIR}" diff --quiet --no-ext-diff || ! git -C "${ROOT_DIR}" diff --cached --quiet --no-ext-diff; then
    echo "Including local uncommitted changes in the published image."
  fi
}

ensure_builder() {
  if docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
    log "Using existing buildx builder ${BUILDER_NAME}"
  else
    log "Creating buildx builder ${BUILDER_NAME}"
    docker buildx create \
      --name "${BUILDER_NAME}" \
      --driver docker-container \
      --driver-opt image=moby/buildkit:buildx-stable-1 \
      --use \
      >/dev/null
  fi

  log "Bootstrapping buildx builder ${BUILDER_NAME}"
  docker buildx inspect "${BUILDER_NAME}" --bootstrap >/dev/null
}

publish_image() {
  log "Building and pushing ${IMAGE_REF}"

  BUILDKIT_PROGRESS="${PROGRESS_MODE}" docker buildx build \
    --builder "${BUILDER_NAME}" \
    --platform "${PLATFORMS}" \
    --provenance=false \
    --sbom=false \
    --progress "${PROGRESS_MODE}" \
    -f "${DOCKERFILE_ABS}" \
    -t "${IMAGE_REF}" \
    --push \
    "${ROOT_DIR}"
}

fetch_digest() {
  log "Inspecting published manifest"
  PUBLISHED_DIGEST="$(
    docker buildx imagetools inspect "${IMAGE_REF}" | awk '/^Digest:/ { print $2; exit }'
  )"

  [[ -n "${PUBLISHED_DIGEST}" ]] || die "Could not determine the published digest for ${IMAGE_REF}"
  echo "Published digest: ${PUBLISHED_DIGEST}"
}

verify_image() {
  local host_port=""
  local health=""

  log "Smoke testing ${IMAGE_REF}"

  cleanup_verify_container
  trap cleanup_verify_container EXIT

  docker pull "${IMAGE_REF}" >/dev/null
  docker run -d --rm \
    --name "${VERIFY_CONTAINER_NAME}" \
    -e HEDGEHUB_START_IBKR_GATEWAY=false \
    -p 127.0.0.1::8787 \
    "${IMAGE_REF}" \
    >/dev/null

  host_port="$(
    docker inspect \
      --format '{{(index (index .NetworkSettings.Ports "8787/tcp") 0).HostPort}}' \
      "${VERIFY_CONTAINER_NAME}"
  )"

  [[ -n "${host_port}" ]] || die "Could not determine the mapped verification port."

  for _attempt in {1..20}; do
    if health="$(curl -fsS "http://127.0.0.1:${host_port}/api/health" 2>/dev/null)"; then
      echo "Health check: ${health}"
      return
    fi
    sleep 1
  done

  docker logs --tail 100 "${VERIFY_CONTAINER_NAME}" >&2 || true
  die "Health check failed for ${IMAGE_REF}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)
      [[ $# -ge 2 ]] || die "--image requires a value"
      IMAGE_REPO="$2"
      shift 2
      ;;
    --tag)
      [[ $# -ge 2 ]] || die "--tag requires a value"
      IMAGE_TAG="$2"
      shift 2
      ;;
    --platforms)
      [[ $# -ge 2 ]] || die "--platforms requires a value"
      PLATFORMS="$2"
      shift 2
      ;;
    --builder)
      [[ $# -ge 2 ]] || die "--builder requires a value"
      BUILDER_NAME="$2"
      shift 2
      ;;
    --dockerfile)
      [[ $# -ge 2 ]] || die "--dockerfile requires a value"
      DOCKERFILE_PATH="$2"
      shift 2
      ;;
    --no-verify)
      VERIFY_AFTER_PUSH=false
      shift
      ;;
    --verify)
      VERIFY_AFTER_PUSH=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

require_command docker
require_command curl
require_command awk
require_command git

IMAGE_REF="${IMAGE_REPO}:${IMAGE_TAG}"

if [[ "${DOCKERFILE_PATH}" = /* ]]; then
  DOCKERFILE_ABS="${DOCKERFILE_PATH}"
else
  DOCKERFILE_ABS="${ROOT_DIR}/${DOCKERFILE_PATH}"
fi

[[ -f "${DOCKERFILE_ABS}" ]] || die "Dockerfile not found: ${DOCKERFILE_ABS}"

show_git_context
ensure_builder
publish_image
fetch_digest

if [[ "${VERIFY_AFTER_PUSH}" == "true" ]]; then
  verify_image
fi

log "Done"
echo "Image: ${IMAGE_REF}"
