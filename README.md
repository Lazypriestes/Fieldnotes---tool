# Interview suite

Three modules, one live interview tool.

```
intermeow/
├── canvas/         the UI — question-tree canvas, timeline, dock, notes
│   └── fieldnotes.html
├── diarization/    audio → diarized transcript (the hard core)
│   ├── pipeline.py        capture → Sortformer diarize (MLX) → Whisper → SQLite
│   ├── store.py server.py setup_audio.py devices.py watch.py run.sh
│   ├── models/  sample_interview.wav  requirements.txt  README.md
│   └── .venv/             (local uv venv, python 3.12 — call by path)
└── analysis/       take the diarized transcript and clean it up + tag coverage
    └── assistant.py       serves canvas UI + /api/segments + /api/coverage,
                           LLM question-matching via local Ollama (llama3.1:8b)
```

## Run a live interview

1. **Diarize** (terminal 1) — writes `diarization/transcript.db`:
   ```bash
   diarization/.venv/bin/python diarization/pipeline.py \
     --source device --device "BlackHole 2ch" --names "Interviewer,Candidate"
   ```
   Or test on the bundled sample:
   ```bash
   diarization/.venv/bin/python diarization/pipeline.py --reset --fast --names "Interviewer,Candidate"
   ```

2. **Analyze + serve** (terminal 2) — serves the canvas at http://localhost:8000:
   ```bash
   diarization/.venv/bin/python analysis/assistant.py
   ```

3. Open http://localhost:8000, click the **◉ live** button in the transport.
   Real speaker turns fill the caption bar; the LLM lights up covered questions
   (green/amber) and fires "answered ahead" as the candidate jumps around.

The demo (▶ play) still runs the canned script with no backend needed.
`assistant.py` defaults resolve to the sibling `canvas/` and `diarization/` folders.

See `diarization/README.md` for the full pipeline docs, audio routing, and tuning.
