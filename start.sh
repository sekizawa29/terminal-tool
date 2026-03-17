#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export PORT=51731
export VITE_PORT=51730
URL="http://127.0.0.1:${VITE_PORT}"

echo "Starting tboard ..."
echo "  Frontend : ${URL}"
echo "  Backend  : http://127.0.0.1:${PORT}"
echo ""

# Install dependencies if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies ..."
  npm install
  echo ""
fi

# Fix node-pty spawn-helper permissions (may be lost when copied from Windows)
if [[ "$(uname)" != MINGW* && "$(uname)" != MSYS* ]]; then
  find node_modules/node-pty/prebuilds -name spawn-helper -exec chmod +x {} + 2>/dev/null || true
fi

# Start dev server in background
npm run dev &
DEV_PID=$!

# Wait for Vite to be ready, then open browser
(
  for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://127.0.0.1:${VITE_PORT}" 2>/dev/null; then
      # Open browser
      if [[ "$(uname)" == "Darwin" ]]; then
        open "$URL"
      elif command -v cmd.exe &>/dev/null; then
        cmd.exe /c start "$URL" 2>/dev/null
      elif command -v wslview &>/dev/null; then
        wslview "$URL"
      elif command -v xdg-open &>/dev/null; then
        xdg-open "$URL"
      fi
      exit 0
    fi
    sleep 1
  done
  echo "Warning: timed out waiting for Vite to start"
) &

# Foreground the dev server so Ctrl+C works
wait $DEV_PID
