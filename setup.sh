#!/usr/bin/env bash
#
# One-time setup for Fieldnotes. Idempotent — safe to re-run.
#
#   ./setup.sh
#
# Builds the Python venv + installs the diarization/transcription stack, and
# pulls the local LLM the analysis layer uses. Everything stays on your machine.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

say() { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
ok()  { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[1;33m!\033[0m %s\n' "$*"; }

say "Fieldnotes setup"

# --- platform note -------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  warn "Diarization runs on Apple-Silicon (MLX). Non-Apple hardware needs the NeMo runtime instead — see diarization/README.md."
fi

# --- 1. uv ---------------------------------------------------------------
if ! command -v uv >/dev/null 2>&1; then
  warn "uv not found. Install it, then re-run ./setup.sh :"
  echo "      curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi
ok "uv present ($(uv --version))"

# --- 2. venv + dependencies ---------------------------------------------
if [ -x diarization/.venv/bin/python ]; then
  ok "venv already exists (diarization/.venv)"
else
  say "creating diarization/.venv (Python 3.12)"
  uv venv --python 3.12 diarization/.venv >/dev/null
  ok "venv created"
fi

say "installing dependencies (pulls PyTorch + MLX — a few minutes on first run)"
VIRTUAL_ENV="$DIR/diarization/.venv" uv pip install -q -r diarization/requirements.txt
ok "dependencies installed"

# --- 3. Ollama model (for the analysis / coverage layer) -----------------
MODEL="${FN_MODEL:-llama3.1:8b}"
if command -v ollama >/dev/null 2>&1; then
  if ollama list 2>/dev/null | grep -q "^${MODEL%%:*}"; then
    ok "Ollama model present ($MODEL)"
  else
    say "pulling Ollama model $MODEL (~5 GB)"
    ollama pull "$MODEL" && ok "model pulled" || warn "pull failed — run later:  ollama pull $MODEL"
  fi
else
  warn "Ollama not found — live question-coverage needs it."
  echo "      install from https://ollama.com , then:  ollama pull $MODEL"
fi

echo ""
say "Done. Try it:"
echo "    # 1) diarize the bundled sample -> diarization/transcript.db"
echo "    diarization/.venv/bin/python diarization/pipeline.py --reset --fast --names \"Interviewer,Candidate\""
echo "    # 2) serve the app  (or just:  ./start.sh )"
echo "    diarization/.venv/bin/python analysis/assistant.py"
echo "    # 3) open http://localhost:8000  and click the ◉ live button"
echo ""
echo "  First pipeline run also downloads the diarizer + Whisper models (~1.7 GB, cached)."
