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
      # Open in app mode (no address bar / bookmarks)
      open_app() {
        for browser in \
          "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
          "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
          "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
          "/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
          "/mnt/c/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"; do
          if [ -f "$browser" ]; then
            "$browser" --app="$URL" --new-window 2>/dev/null &
            return 0
          fi
        done
        return 1
      }

      if [[ "$(uname)" == "Darwin" ]]; then
        # macOS: try Chrome, then Edge (app mode), then Safari (no app mode)
        if open -na "Google Chrome" --args --app="$URL" 2>/dev/null; then :
        elif open -na "Microsoft Edge" --args --app="$URL" 2>/dev/null; then :
        elif open -a Safari "$URL" 2>/dev/null; then :
        else open "$URL"
        fi
      elif command -v cmd.exe &>/dev/null; then
        # WSL
        open_app || cmd.exe /c start "$URL" 2>/dev/null
      elif command -v google-chrome &>/dev/null; then
        google-chrome --app="$URL" 2>/dev/null &
      elif command -v google-chrome-stable &>/dev/null; then
        google-chrome-stable --app="$URL" 2>/dev/null &
      elif command -v chromium-browser &>/dev/null; then
        chromium-browser --app="$URL" 2>/dev/null &
      elif command -v microsoft-edge &>/dev/null; then
        microsoft-edge --app="$URL" 2>/dev/null &
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
