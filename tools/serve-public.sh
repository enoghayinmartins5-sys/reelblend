#!/usr/bin/env bash
# ============================================================================
# serve-public.sh — run ReelBlend behind a public Cloudflare quick tunnel.
#
# Why this exists: a Cloudflare quick tunnel is the fastest way to get a real
# public HTTPS URL with no account, but it has two failure modes we hit in
# practice — the tunnel connection can idle-timeout on a paused VM, and every
# restart mints a NEW hostname. This script handles both:
#
#   * HTTP/2 over TCP instead of QUIC (survives network idle timeouts)
#   * an explicit 127.0.0.1 origin (never dials IPv6 localhost)
#   * auto-restart if cloudflared dies
#   * always writes the CURRENT url to PUBLIC_URL.txt
#
# Usage
#   bash tools/serve-public.sh              # foreground, Ctrl-C to stop
#   PORT=9000 bash tools/serve-public.sh
#   TUNNEL_PROTOCOL=quic bash tools/serve-public.sh
# ============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
CF_BIN="${CF_BIN:-/tmp/cf/cloudflared}"
URL_FILE="$ROOT/PUBLIC_URL.txt"
PROTOCOL="${TUNNEL_PROTOCOL:-http2}"
URL_RE='https://[a-z0-9-]+\.trycloudflare\.com'

cleanup() {
  echo
  echo "[exit] shutting down the tunnel…"
  [ -n "${CF_PID:-}" ] && kill "$CF_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# ── 1. the tunnel binary ───────────────────────────────────────────────────
if [ ! -x "$CF_BIN" ]; then
  echo "[setup] downloading cloudflared…"
  mkdir -p "$(dirname "$CF_BIN")"
  curl -sL -o "$CF_BIN" \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$CF_BIN"
fi

# ── 2. the app ─────────────────────────────────────────────────────────────
if curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" > /dev/null; then
  echo "[app] already serving on :$PORT"
else
  echo "[app] starting ReelBlend on :$PORT"
  (cd "$ROOT" && nohup node server/index.js > /tmp/reelblend.log 2>&1 &)
  for _ in $(seq 1 30); do
    curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" > /dev/null && break
    sleep 0.5
  done
fi

# ── 3. tunnel supervisor loop ──────────────────────────────────────────────
while true; do
  echo "[tunnel] opening public tunnel (protocol=$PROTOCOL)…"
  LOG="$(mktemp)"
  "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --protocol "$PROTOCOL" \
    --no-autoupdate --edge-ip-version 4 > "$LOG" 2>&1 &
  CF_PID=$!

  URL=""
  for _ in $(seq 1 60); do
    URL="$(grep -oE "$URL_RE" "$LOG" 2>/dev/null | head -1)"
    [ -n "$URL" ] && break
    kill -0 "$CF_PID" 2>/dev/null || break
    sleep 1
  done

  if [ -n "$URL" ]; then
    printf '%s\n' "$URL" > "$URL_FILE"
    echo
    echo "  ╭──────────────────────────────────────────────────────────────╮"
    printf  '  │  PUBLIC URL → %-46s│\n' "$URL"
    echo "  ╰──────────────────────────────────────────────────────────────╯"
    echo "  saved to $URL_FILE"
    echo
  fi

  wait "$CF_PID"
  echo "[tunnel] connection ended — restarting in 3s (a new hostname will be issued)"
  echo "[tunnel] note: a stable URL needs a named tunnel or a real host (see README)"
  sleep 3
done
