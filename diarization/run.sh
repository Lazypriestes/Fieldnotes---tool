#!/usr/bin/env bash
#
# One command for the whole lifecycle.
#
#   ./run.sh
#
# On start it stops any previous run, wipes the old transcript, turns on audio
# routing, then launches the viewer and the pipeline fresh.
# Press Ctrl-C once and it stops everything and puts the machine back to normal:
# kills both processes, reverts the audio output (so your volume keys work again),
# and — by default — wipes the transcript.
#
# Adjustable knobs (env vars or edit here):
DEVICE="${DEVICE:-BlackHole 2ch}"     # capture device
MAX_SPEAKERS="${MAX_SPEAKERS:-3}"     # ceiling on speakers created
PORT="${PORT:-8000}"                  # viewer port
WIPE_ON_STOP="${WIPE_ON_STOP:-true}"  # false = keep the transcript after Ctrl-C
OPEN_BROWSER="${OPEN_BROWSER:-true}"  # false = don't auto-open the page
HEAR="${HEAR:-true}"                  # true = play through speakers too; false = silent capture
SPEAKER_VOLUME="${SPEAKER_VOLUME:-45}"  # speaker level in HEAR mode (aggregate ignores volume keys)

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$DIR/.venv/bin/python"
cd "$DIR"

wipe_db() { rm -f "$DIR"/transcript.db "$DIR"/transcript.db-wal "$DIR"/transcript.db-shm; }

stop_procs() {
    pkill -f "$DIR/.venv/bin/python .*pipeline.py" 2>/dev/null
    pkill -f "$DIR/.venv/bin/python .*server.py"   2>/dev/null
    # fallback for pgrep that doesn't see the full path
    pkill -f "pipeline.py" 2>/dev/null
    pkill -f "server.py"   2>/dev/null
}

cleanup() {
    trap - INT TERM HUP EXIT      # don't re-enter while cleaning up
    echo ""
    echo "[stop] shutting down..."
    stop_procs
    "$PY" setup_audio.py revert >/dev/null 2>&1 && echo "[stop] audio output reverted"
    if [ "$WIPE_ON_STOP" = "true" ]; then
        wipe_db; echo "[stop] transcript wiped"
    else
        echo "[stop] transcript kept: $DIR/transcript.db"
    fi
    echo "[stop] done."
    exit 0
}
# EXIT catches every other way out (pipeline dies, an error, a plain kill), so the
# machine is always put back to normal. INT/TERM/HUP cover Ctrl-C and terminal close.
trap cleanup INT TERM HUP EXIT

# ---- fresh start ---------------------------------------------------------
echo "[start] stopping any previous run..."
stop_procs
sleep 1

echo "[start] wiping old transcript..."
wipe_db

if [ "$HEAR" = "true" ]; then
    echo "[start] audio: MONITOR — you hear it through speakers AND it's captured"
    "$PY" setup_audio.py volume --level "$SPEAKER_VOLUME" >/dev/null 2>&1
    "$PY" setup_audio.py activate >/dev/null 2>&1
else
    echo "[start] audio: SILENT — captured only, nothing to the speakers"
    "$PY" setup_audio.py capture-only >/dev/null 2>&1
fi
if ! "$PY" setup_audio.py status 2>/dev/null | grep -q "ready ("; then
    echo "[start] !! audio not ready. Is BlackHole + the Multi-Output device set up?"
    echo "[start]    run:  $PY setup_audio.py status"
    exit 1
fi
echo "[start] audio ready."

echo "[start] launching viewer on http://localhost:$PORT ..."
"$PY" server.py --port "$PORT" >/tmp/ia_server.log 2>&1 &

echo "[start] launching pipeline on \"$DEVICE\" ..."
"$PY" pipeline.py --source device --device "$DEVICE" --max-speakers "$MAX_SPEAKERS" &
PIPELINE_PID=$!

sleep 2
[ "$OPEN_BROWSER" = "true" ] && open "http://localhost:$PORT" 2>/dev/null

echo ""
echo "  ┌────────────────────────────────────────────────┐"
echo "  │  Live captions:  http://localhost:$PORT           │"
echo "  │  Play your video now.                            │"
echo "  │  Ctrl-C here stops everything and resets.        │"
echo "  └────────────────────────────────────────────────┘"
if [ "$HEAR" = "true" ]; then
    echo "  audio: MONITOR at ${SPEAKER_VOLUME}%.  Adjust live from another terminal:"
    echo "         $PY setup_audio.py volume --level 60"
    echo "  (start muted instead:  HEAR=false ./run.sh)"
else
    echo "  audio: SILENT.  To hear it too:  HEAR=true ./run.sh"
fi
echo ""

# Stay alive until the pipeline exits or a signal arrives. We loop on a short,
# interruptible sleep instead of a bare `wait $PIPELINE_PID`, because bash defers
# an INT/TERM trap until a foreground `wait` returns — which would hang cleanup if
# the pipeline itself didn't happen to get the same signal.
while kill -0 "$PIPELINE_PID" 2>/dev/null; do
    sleep 1 & wait $! 2>/dev/null
done
cleanup                 # pipeline exited on its own -> tidy up too
