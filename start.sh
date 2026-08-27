#!/usr/bin/env bash
#
# Serve the Fieldnotes app (the analysis layer: canvas UI + transcript API + LLM coverage).
#
#   ./start.sh                 # http://localhost:8000
#   PORT=9000 ./start.sh
#
# Run the diarization pipeline separately to feed it live audio (see README).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$DIR/diarization/.venv/bin/python"
PORT="${PORT:-8000}"

if [ ! -x "$PY" ]; then
  echo "!! venv missing — run ./setup.sh first."; exit 1
fi

echo "Fieldnotes -> http://localhost:$PORT   (ctrl-c to stop)"
echo "Open the page, click ◉ to go live (the server starts diarization for you)."
( sleep 1; command -v open >/dev/null 2>&1 && open "http://localhost:$PORT" ) &
exec "$PY" "$DIR/analysis/assistant.py" --port "$PORT"
