#!/usr/bin/env bash
set -euo pipefail

# Launches OpenIDEA in headless web server mode on a configurable host and port.
# Environment variables:
#   OPENIDEA_HOST            Bind address (default: 0.0.0.0)
#   OPENIDEA_PORT            Listen port (default: 8080)
#   OPENIDEA_WORKSPACE_DIR   Workspace directory to open on startup (optional)
#   OPENIDEA_SERVER_HOME     Persistent config/data directory (defaults to
#                            <workspace>/.openidea-server when a workspace is set,
#                            else $HOME/.openidea)
#   OPENIDEA_WEB_DIR         Path to built frontend assets (default: auto-detected)
#   OPENIDEA_BASE_PATH       Optional reverse-proxy URL prefix
#   OPENIDEA_WEB_TOKEN       Optional access token ('auto' generates one)

HOST="${OPENIDEA_HOST:-0.0.0.0}"
PORT="${OPENIDEA_PORT:-8080}"
WORKSPACE_DIR="${OPENIDEA_WORKSPACE_DIR:-}"

if [[ -n "${WORKSPACE_DIR}" && -z "${OPENIDEA_SERVER_HOME:-}" ]]; then
  export OPENIDEA_SERVER_HOME="${WORKSPACE_DIR}/.openidea-server"
fi

if [[ -n "${OPENIDEA_SERVER_HOME:-}" ]]; then
  mkdir -p "${OPENIDEA_SERVER_HOME}/config" "${OPENIDEA_SERVER_HOME}/data"
fi

ARGS=(--web --host "${HOST}" --port "${PORT}")

if [[ -n "${OPENIDEA_WEB_DIR:-}" ]]; then
  ARGS+=(--web-dir "${OPENIDEA_WEB_DIR}")
fi

if [[ -n "${OPENIDEA_BASE_PATH:-}" ]]; then
  ARGS+=(--base-path "${OPENIDEA_BASE_PATH}")
fi

if [[ -n "${WORKSPACE_DIR}" ]]; then
  ARGS+=(--project "${WORKSPACE_DIR}")
fi

if [[ -n "${OPENIDEA_WEB_TOKEN:-}" ]]; then
  ARGS+=(--token "${OPENIDEA_WEB_TOKEN}")
fi

BIN="${OPENIDEA_SERVER_BIN:-openidea-server}"
exec "${BIN}" "${ARGS[@]}" "$@"
