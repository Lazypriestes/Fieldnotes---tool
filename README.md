# Fieldnotes

A live interview tool. It listens to a call, separates who's speaking, transcribes it,
and lights up a visual question-tree as the conversation covers your plan — showing
what's answered, what's been answered *ahead* of where you are, and what's still open.
Everything runs locally.

```
canvas/         the UI — a hand-built question-tree canvas, timeline, notes, dock
diarization/    audio → speaker-separated transcript (Sortformer + Whisper → SQLite)
analysis/       serves the canvas + tags question-coverage with a local LLM (Ollama)
```

## Requirements

- **macOS on Apple Silicon** — diarization uses MLX (the Apple-Silicon GPU). Other
  hardware needs the NeMo runtime of the same model (see `diarization/README.md`).
- **[uv](https://astral.sh/uv)** — Python 3.12 env + package manager
  `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **[Ollama](https://ollama.com)** — runs the coverage LLM locally (setup pulls `llama3.1:8b`)
- **[BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)** — *only for live calls*
  (loopback so macOS lets you capture system audio): `brew install blackhole-2ch`

## Install

```bash
git clone git@github.com:Lazypriestes/Fieldnotes---tool.git fieldnotes
cd fieldnotes
./setup.sh
```

`setup.sh` builds `diarization/.venv`, installs the stack (PyTorch + MLX), and pulls the
Ollama model. It's idempotent — re-run it anytime. The **first pipeline run** additionally
downloads the diarizer + Whisper models (~1.7 GB) into `~/.cache/huggingface` and caches them.

## Run

```bash
./start.sh
```

That serves the app and opens **http://localhost:8000**. Then:

- **▶ play** — canned demo, no backend needed.
- **◉ go live** — pick a source in the little dropdown and click ◉. The server **starts
  diarization for you** (no second terminal) and the canvas fills from the real transcript
  + LLM coverage. Click ◉ again (or ▪ stop) to end it — the pipeline stops too.

Sources:
- **Sample** — streams `sample_interview.wav` at real time, like a live call. Zero setup;
  the default, ideal for a quick demo.
- **Microphone** — captures your mic (in-person interviews). First run asks macOS for mic
  permission.
- **A real call** (Zoom/Teams/video system audio) needs a loopback driver —
  `brew install blackhole-2ch` — then set the mic option to your BlackHole/Aggregate device
  in `analysis/assistant.py` (or run the pipeline manually, below). See `diarization/README.md`.

Manual two-terminal way still works if you prefer it:

```bash
diarization/.venv/bin/python diarization/pipeline.py --reset --fast --names "Interviewer,Candidate"
./start.sh
```

## How it fits together

```
audio ─▶ diarization/pipeline.py ─▶ diarization/transcript.db ─▶ analysis/assistant.py ─▶ canvas
         (Sortformer + Whisper)       (SQLite, live-readable)      (serves UI + /api/*,
                                                                    Ollama coverage worker)
```

- The pipeline and the server share **only the SQLite file** — the server opens it
  read-only, so the viewer can never corrupt a transcript.
- `analysis/assistant.py` serves the canvas UI and three endpoints: `/api/segments`
  (transcript), `/api/plan` (POST your question tree), `/api/coverage` (LLM verdicts).
  Its paths default to the sibling `canvas/` and `diarization/` folders.

## Notes

- **Local-only.** No audio or text leaves the machine — transcription and the coverage
  LLM both run on your hardware.
- **Coverage quality** tracks the local model (`llama3.1:8b` by default; override with
  `FN_MODEL`). It's rough on an 8B model, and it needs the interview's topic to match the
  loaded question tree.
- **Licensing.** CrisperWhisper (default transcriber) is free for research; commercial use
  needs a Nyra Health licence — or switch to `--engine whisper` (MIT). See `diarization/README.md`.
