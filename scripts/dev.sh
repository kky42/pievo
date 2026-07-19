#!/usr/bin/env bash
# Local dev: run the Pievo backend (main.ts — the single scheduler + machine
# endpoints + UI API) and the TanStack UI (which proxies the backend) together.
#
#   BACKEND_PORT (default 8787) · UI_PORT (default 3000)
#
# Connect a machine separately:
#   PIEVO_TOKEN=<tok> PIEVO_SERVER_URL=http://127.0.0.1:8787 \
#     node packages/daemon/dist/cli.js
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/packages/server"
BACKEND_PORT="${BACKEND_PORT:-8787}"
UI_PORT="${UI_PORT:-3000}"
export PIEVO_DATA_DIR="${PIEVO_DATA_DIR:-$HOME/.pievo}"

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "▶ backend (main.ts) on :$BACKEND_PORT  ·  data dir $PIEVO_DATA_DIR"
( cd "$SERVER_DIR" && PIEVO_PORT="$BACKEND_PORT" pnpm exec tsx src/main.ts ) &
pids+=($!)

echo "▶ UI (vite dev) on :$UI_PORT  ·  proxying http://127.0.0.1:$BACKEND_PORT"
( cd "$SERVER_DIR" && PIEVO_PORT="$UI_PORT" PIEVO_API_BASE="http://127.0.0.1:$BACKEND_PORT" pnpm dev ) &
pids+=($!)

echo "▶ open http://127.0.0.1:$UI_PORT"
wait
