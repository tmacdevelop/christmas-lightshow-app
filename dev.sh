#!/usr/bin/env bash
# dev.sh — Start the backend API and Angular UI concurrently.
# Run from the repo root: ./dev.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
    echo -e "\nStopping processes..."
    kill "$API_PID" "$UI_PID" 2>/dev/null
    wait "$API_PID" "$UI_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

cargo run --package api &
API_PID=$!
echo "Started API (PID $API_PID)"

(cd "$ROOT/ui" && pnpm run start) &
UI_PID=$!
echo "Started UI  (PID $UI_PID)"

echo ""
echo "API : http://127.0.0.1:3000"
echo "UI  : http://localhost:4200"
echo ""
echo "Press Ctrl+C to stop both processes..."

wait
