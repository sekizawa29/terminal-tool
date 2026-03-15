#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

export PORT=51731
export VITE_PORT=51730

echo "Starting tboard ..."
echo "  Frontend : http://127.0.0.1:${VITE_PORT}"
echo "  Backend  : http://127.0.0.1:${PORT}"
echo ""

npm run dev
