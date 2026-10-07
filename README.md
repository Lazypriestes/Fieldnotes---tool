# Fieldnotes

A live interview tool. It listens to a call, separates who's speaking, transcribes it,
and lights up a visual question-tree as the conversation covers your plan — showing
what's answered, what's been answered *ahead* of where you are, and what's still open.
Everything runs locally.

```
canvas/         the UI — a hand-built question-tree canvas, timeline, notes, dock
diarization/    audio → who-spoke-when → transcript (Nemotron / call channels + Parakeet → SQLite)
analysis/       serves the canvas; local-LLM coverage, anonymization, summaries, export, import
```

## Requirements

- **macOS on Apple Silicon** — diarization uses MLX (the Apple-Silicon GPU). Other
  hardware needs the NeMo runtime of the same model (see `diarization/README.md`).
- **[uv](https://astral.sh/uv)** — Python 3.12 env + package manager
  `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **[Ollama](https://ollama.com)** — runs the local LLM (setup pulls `llama3.2:3b`)
- **Xcode command-line tools** (`xcode-select --install`) — builds the call-audio capture
  helper and the on-device OCR used to import pictures. macOS **14.4+** for call capture.
- *Optional:* [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) — only as a
  fallback; calls are captured without it.

## Install

```bash
git clone -b main git@github.com:Lazypriestes/intermeow.git fieldnotes
cd fieldnotes
./setup.sh
```

`setup.sh` builds `diarization/.venv`, installs the stack (MLX, PyTorch, document tools),
builds the call-capture helper, pulls the Ollama model and pre-downloads the speech models
(Parakeet, Nemotron-3-Diarization, Sortformer — ~1.7 GB, cached in `~/.cache/huggingface`).
It's idempotent — re-run it anytime.

## Run

```bash
./start.sh
```

That serves the app and opens **http://localhost:8000**. Then:

- **▶ play** — canned demo, no backend needed.
- **◉ go live** — pick a source in the little dropdown and click ◉. The server **starts
  diarization for you** (no second terminal) and the canvas fills from the real transcript
  + LLM coverage. Click ◉ again (or ■ stop) to end it — the pipeline stops too.

Sources (the app remembers your last choice):
- **Online call (me + Teams)** — the one for Teams/Zoom interviews. Records your microphone
  and the call audio as two channels, so *who spoke* comes from the channel (you = mic,
  them = the call) — exact, and no diarization model runs. Echo from your speakers into the
  mic is ignored; headphones still give the cleanest result. A second dropdown covers a
  **second interviewer**: *in the room* (your mic is split between the two of you) or *on
  the call* (the call side is split; the remote voice that talks most is the Candidate).
  The **Speakers** button on the live bar shows who was heard and lets you rename anyone.
  No loopback driver, no output rerouting (Core Audio process tap, macOS 14.4+). First run
  asks for **Microphone** access for *Fieldnotes System Audio*.
- **In person (microphone)** — everyone in one room, no call: Nemotron separates every
  voice on the one mic.
- **Listen only (Teams, no mic)** — just the call side, e.g. when you only observe or are
  recording a webinar. Your own voice is not captured.
- **Sample demo** — streams `sample_interview.wav` at real time, like a live call. Only this
  source shows the ▶ / ⏸ buttons, which run the scripted demo.
- **BlackHole** (fallback, command line only) — `brew install blackhole-2ch`, then run the
  pipeline against your BlackHole/Aggregate device; see `diarization/README.md`.

**Interview session** (tree menu, or the save button by ◉): a live interview is saved to
`sessions/` every 10 s and when you stop. You can download it as one file, open a file or a
saved session again, and if the page reloads mid-interview, **resume** where you left off.

Press **?** in the app for a full controls cheat-sheet.

## What you can do

- **Question tree** — edit it on the canvas (**E**); several trees in the tree menu (top left).
- **During an interview** — the current question pulses; answered / touched / open questions
  colour in; answers given *ahead* of time are flagged. **R** records a clip from 10 s back
  until you release; rate it or add a note. Add notes and new questions as you go.
- **Pages** (**S** cycles) — *Tree*, *Annotation* (answers pinned to their questions) and
  *Mind map*: the same tree plus, beside it, an AI summary per category that opens into
  its answers (each linked to every question it covers — click to jump there), recordings
  with their full script, and notes. **The mind map shows only anonymized text.**
- **Anonymization** — people's names become `[PERSON]`: the local LLM finds the names,
  the server masks them (company, product and place names are kept). Best effort; it
  errs toward hiding a word too many rather than leaking one.
- **Export** (tree menu › Export document) — Word or PDF with any mix of: the question plan
  and what was covered, annotated answers or the whole script, notes, recorded parts
  marked, names anonymized. If anonymization fails, nothing is exported.
- **Import** (tree menu › Import tree) — build a question tree from a **tldraw** board
  (arrows/frames give the structure), **Word**, **PDF**, a **picture** (read on-device),
  or text/Markdown. **Miro:** use Miro's *Export › PDF or image*, then import that. The
  LLM only arranges lines, so your questions keep their exact wording.

Manual two-terminal way still works if you prefer it:

```bash
diarization/.venv/bin/python diarization/pipeline.py --reset --fast --names "Interviewer,Candidate"
./start.sh
```

## How it fits together

```
audio ─▶ diarization/pipeline.py ─▶ diarization/transcript.db ─▶ analysis/assistant.py ─▶ canvas
         (who spoke: Nemotron, or     (SQLite, live-readable)      (serves UI + /api/*,
          the channel in Call mode;                                 Ollama coverage worker)
          words: Parakeet)
```

- The pipeline and the server share **only the SQLite file** — the server opens it
  read-only, so the viewer can never corrupt a transcript.
- `analysis/assistant.py` serves the canvas UI and the API: `/api/segments` (transcript),
  `/api/plan` (your question tree), `/api/coverage` (LLM verdicts), `/api/start` · `/stop`
  · `/status` (the live pipeline), `/api/anonymize`, `/api/summarize`, `/api/export`
  (`analysis/docexport.py`), `/api/import` (`analysis/docimport.py`), `/api/cues`.
  Its paths default to the sibling `canvas/` and `diarization/` folders.

## Notes

- **Local-only.** No audio or text leaves the machine — capture, transcription, OCR and
  every LLM call run on your hardware.
- **Memory.** Live mode runs the speech models plus Ollama; on a 24 GB Mac close heavy apps
  first. Call mode is the lightest (~1 GB for the pipeline — no diarizer).
- **LLM quality** tracks the local model (`llama3.2:3b` by default; override with
  `FN_MODEL`). A 3B model is fast but rough: coverage tags and summaries can be clumsy, and
  coverage needs the interview's topic to match the loaded question tree.
- **Licensing.** Parakeet (default transcriber, CC-BY-4.0) and Nemotron-3-Diarization
  (OpenMDW) allow commercial use. The optional CrisperWhisper engine is research-only
  without a Nyra Health licence. See `diarization/README.md`.
