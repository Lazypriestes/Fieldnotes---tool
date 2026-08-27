# Live transcription + speaker separation (prototype)

Captures audio from a file or a live call, transcribes it as it happens, labels who
is speaking, and appends everything to a local SQLite file that another process can
read **while the call is still going**. That last part is the point: it's the seam
where an LLM plugs in later.

Everything runs locally. No API keys, no audio leaves the machine — verified by running
the full pipeline under `sandbox-exec` with all network syscalls denied, which produced
byte-identical output. The only network access is the one-time model download below.

```
audio ─▶ 1s chunks ─▶ Sortformer stream ─▶ merge into turns ─▶ CrisperWhisper ─▶ SQLite (WAL)
                      (who spoke, when)      per speaker turn   or Whisper         │
                          [GPU/MLX]                            (words) [GPU/MPS]    ▼
                                                                    watch.py / server / LLM
```

Diarization is **NVIDIA Sortformer**, a streaming neural diarizer running on the Apple
Silicon GPU via MLX. One model does voice-activity, segmentation and speaker assignment —
no threshold to tune, no cold-start, no guessing the speaker count (it handles up to 4),
and it's robust to overlapping speech. This replaced an earlier voice-embedding +
clustering diarizer (kept as `pipeline_embedding_backup.py`).

Transcription runs on the GPU via PyTorch/MPS and has two selectable engines (`--engine`):

- **`crisper`** (default) — **CrisperWhisper**, a verbatim Whisper fine-tune. It keeps
  fillers and false starts (`--mode verbatim`) or cleans them up (`--mode intended`), and
  its word timestamps are tuned for disfluency. Needs a Nyra Health licence for commercial
  use (see below).
- **`whisper`** — **stock OpenAI Whisper** via HuggingFace transformers (`--whisper-model`,
  default `openai/whisper-medium`). MIT-licensed, no verbatim disfluencies (so `--mode` is
  ignored), same speed class. Pick this if the downstream consumer only needs clean text
  and you want to avoid the CrisperWhisper licence.

On the test sample CrisperWhisper edged out stock Whisper-medium at the same size — correct
tense and pronoun ("moved"/"cached"/"you ran into") where Whisper-medium produced
"move"/"cache"/"he ran into" and misheard "hardest problem" as "artist's problem". That's
one short synthetic clip, though, not a benchmark — run both on your real audio before
committing. Both GPUs are used at once — Sortformer on MLX-Metal, the transcriber on
torch-MPS.

## Reference commands

All of these are verified working on this machine. Run them from anywhere — paths resolve
against the scripts, not your shell. `cd` into the project first if you prefer the short form.

**Capture a video or a call.** No diarization tuning needed — Sortformer handles the
speaker logic on its own:

```bash
.venv/bin/python pipeline.py --reset --source device --device "BlackHole 2ch" --names "Interviewer,Candidate"
```

`--names` maps `S1`/`S2`… to real names in order of first appearance. That's usually the
only flag you need; the diarization knobs (below) have sensible defaults.

**Watch it, in a second terminal**, then open <http://localhost:8000>:

```bash
.venv/bin/python server.py
```

**Check the audio routing** — tells you the next step to fix if something is off:

```bash
.venv/bin/python setup_audio.py status
```

**One-time machine setup** (already done here):

```bash
brew install blackhole-2ch && sudo killall coreaudiod
```
```bash
.venv/bin/python setup_audio.py create && .venv/bin/python setup_audio.py activate
```

**Hear the audio while capturing, or capture silently.** `run.sh` defaults to *monitor*
mode — you hear it through the speakers and it's captured. The Multi-Output Device has no
master volume (the keyboard volume keys do nothing while it's active), so the level is set
explicitly and can be changed live from another terminal:

```bash
HEAR=true SPEAKER_VOLUME=50 ./run.sh          # hear it (default)
HEAR=false ./run.sh                           # silent: capture only
.venv/bin/python setup_audio.py volume --level 65   # change level mid-session
```

If it ever comes up silent in monitor mode, the cause is one of: output left on
BlackHole-only, the speaker sub-device muted, or its volume at zero. `setup_audio.py volume`
fixes all three at once (it sets the level *and* clears mute on the real speaker even while
it's buried inside the aggregate).

**Give your speakers back** when you're finished — this also restores the volume keys:

```bash
.venv/bin/python setup_audio.py revert
```

**Try it without any audio setup**, against the bundled two-speaker sample:

```bash
.venv/bin/python pipeline.py --reset --fast --names "Interviewer,Candidate"
```

---

Files, ~600 lines total:

| file | role |
|---|---|
| `pipeline.py` | the whole pipeline (capture → Sortformer diarize → Whisper → store) |
| `store.py` | SQLite schema + read/write |
| `watch.py` | tails the transcript live — this is the LLM hook |
| `server.py` + `viewer.html` | live caption view in a browser |
| `setup_audio.py` | create/route the BlackHole loopback + speaker volume |
| `devices.py` | lists audio devices |
| `run.sh` | one-command start/stop of the whole thing |
| `mlx_test.py` | standalone Sortformer diarization test |
| `pipeline_embedding_backup.py`, `diarize.py` | retired voice-embedding diarizer |

## Setup

```bash
uv venv --python 3.12 .venv
uv pip install -r requirements.txt
```

That's it — no model files to download by hand. On first run the pipeline pulls the
Sortformer diarizer (~230 MB fp16) and the transcription model (CrisperWhisper medium
~1.5 GB, or `openai/whisper-medium` ~3 GB under `--engine whisper`), both cached in
`~/.cache/huggingface` and fully local afterwards. Note this venv is **not** lightweight:
PyTorch (~2.5 GB) comes in via Sortformer (mlx-audio) and both transcription engines use
it. A CTranslate2 build (faster-whisper) can't coexist with torch — see the limitations.

**Licensing:** CrisperWhisper's standard models are free for research; commercial use
needs a licence from Nyra Health. That matters if this prototype ships as part of a
product — sort it out before then, or switch to `--engine whisper`, which runs stock
MIT-licensed OpenAI Whisper with no such restriction.

### Why Sortformer for diarization

The first version of this prototype used voice-embedding + cosine clustering (still in
`pipeline_embedding_backup.py`). It worked but had three chronic problems: a similarity
threshold that had to be hand-tuned per audio source, a cold-start where the first clip
of a voice defined that speaker badly, and it split one person across several labels.
And it could not represent overlapping speech at all.

**Sortformer** (`nvidia/diar_streaming_sortformer_4spk-v2.1`, run here through its MLX
port `mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16`) is a single streaming
neural diarizer that removes all of that: no threshold, no cold-start, no speaker-count
guess (it handles up to 4), and it detects overlap. Tested on the bundled sample it gave
perfect speaker attribution on clean *and* Opus-24k-plus-noise audio, at ~0.08 real-time
on the GPU — the diarization is essentially free next to Whisper.

It's the same NVIDIA model NVIDIA ships for GPU servers via NeMo; the MLX build just runs
those exact weights on the Apple-Silicon GPU with no PyTorch/CUDA. For a Linux/GPU
deployment of the larger project, the NeMo runtime of the same model is the counterpart.

### No environment to activate

`.venv/bin/python` runs the right interpreter directly — `source .venv/bin/activate` is
never required. Your system `python3` is 3.13 and does **not** have these packages; the
venv is 3.12 and has all of them, so always call it by path.

Every default path resolves against the script's own folder, not your shell's working
directory, so this works from anywhere with no arguments at all:

```bash
/Users/mama17/Documents/HYUX/interview_assistant/.venv/bin/python \
  /Users/mama17/Documents/HYUX/interview_assistant/pipeline.py --fast
```

`transcript.db` always lands next to the scripts, so `pipeline.py`, `watch.py` and
`server.py` agree on where it is even when launched from different directories. An
explicit `--db` is still taken exactly as you type it.

If you'd rather activate a shell for a session, `source .venv/bin/activate` then plain
`python pipeline.py` also works — it's just not needed.

## Try it now

A two-speaker test conversation is included (`sample_interview.wav`, generated with
macOS `say`). This streams it at realtime speed, as if it were a live call:

```bash
.venv/bin/python pipeline.py --source file --path sample_interview.wav --names "Interviewer,Candidate"
```

In a second terminal, watch the transcript fill in live:

```bash
.venv/bin/python watch.py
```

Add `--fast` to the pipeline to process a recording as fast as possible instead of
pacing it to realtime.

## Real calls (Teams / Zoom / a video)

macOS won't let an app record system audio without a loopback driver. Install one:

```bash
brew install blackhole-2ch
```

That needs your password and a logout/login to load the driver.

Then in **Audio MIDI Setup**:

1. **Multi-Output Device** = BlackHole 2ch + your speakers/headphones.
   Set it as the system output. You still hear the call; a copy goes to BlackHole.
2. **Aggregate Device** = BlackHole 2ch + your microphone.
   This is what you capture from — it carries the remote participants *and* you.

Then:

```bash
.venv/bin/python devices.py                          # find the exact name
.venv/bin/python pipeline.py --source device --device "Aggregate Device"
```

**First run will need microphone permission.** macOS blocks audio capture until you
grant it to whichever app runs the process (Terminal, iTerm, etc.) under
System Settings → Privacy & Security → Microphone. Until it's granted the process
just hangs with no error, which is confusing the first time.

## Live captions in a browser

```bash
.venv/bin/python server.py          # -> http://localhost:8000
```

Leave it running in its own terminal; it's independent of the pipeline and you can start
either one first. Each speaker gets **both a colour and a typeface** — blue bold sans,
amber italic serif, green mono, and so on — so you can tell turns apart at a glance
without reading the labels. Newest line is bright, older ones dim back. It follows the
bottom automatically, but scrolling up to re-read pauses that until you scroll back down.

Starting a new pipeline run clears the page on its own. The database is opened read-only,
so the viewer can never corrupt a transcript.

### Verifying with a YouTube video

Easier than the Teams setup: a video has no microphone side, so you need **only BlackHole**
— no Aggregate Device.

1. System output → **Multi-Output Device** (BlackHole 2ch + your speakers)
2. `.venv/bin/python pipeline.py --source device --device "BlackHole 2ch"`
3. `.venv/bin/python server.py` and open <http://localhost:8000>
4. Play the video in another tab and watch the captions land

Pick something with two clearly different voices — an interview or a podcast — since that
exercises the speaker separation. A single-narrator video only proves transcription works.

## Running alongside a live Teams / Zoom call

It runs as a separate process reading an audio device — it does not hook into Teams,
so Teams has no idea it's there (and shows no recording indicator to the other side).

**Teams holding the microphone does not block this script.** macOS input devices are
shared, not exclusive — unlike WASAPI exclusive mode on Windows. Verified directly: two
processes opened the same microphone at the same time and both read live audio
(158400 and 62400 frames, comparable peak levels). You need no special setup for this;
it simply works.

Set the routing up like this, or you'll get echo:

| | device |
|---|---|
| Teams **microphone** | your raw microphone |
| Teams **speaker** | Multi-Output Device |
| this script `--device` | Aggregate Device |

Pointing Teams' *microphone* at the Aggregate Device feeds the call's own output back
into the call, and the far side hears themselves.

**Wear headphones.** On speakers, your mic picks up the remote voices *and* BlackHole
captures them — every remote utterance gets transcribed twice, and one person can get
split into two speaker labels because direct and room-reflected audio embed differently.

Two macOS quirks that are not bugs in this tool: Multi-Output Devices disable the
keyboard volume keys (adjust volume inside Teams), and you should set your real output
as the master device with drift correction enabled on BlackHole, or the clocks desync
over a long call.

Headroom is not a problem: **29 CPU-seconds to process 35 s of audio — 78 % of one core
on 14, ~1 GB RSS**, and bursty rather than sustained (~2 % idle between utterances).

If you're recording an interview, note that Germany requires consent from all parties
to record spoken conversation (§201 StGB).

## The LLM seam

`watch.py` polls `store.since(session_id, last_id)` and prints each new row. Replace
the print with your call and you have live LLM processing over the conversation:

```python
for row in store.since(session, last_id):
    # row = {id, t_start, t_end, speaker, text}
    last_id = row["id"]
```

SQLite is in WAL mode, so readers never block the writer. Any number of consumers can
poll the same file concurrently.

## Starting fresh

You usually don't need to delete anything: every run is a new session, and the viewer
follows the newest one and clears itself. Delete only when you want the old data gone.

**Stop the pipeline first** (ctrl-c) — removing the database while it is being written to
leaves the running process writing into an unlinked file.

```bash
.venv/bin/python pipeline.py --reset --source device --device "BlackHole 2ch"
```

Or wipe it without starting a run:

```bash
rm -f transcript.db transcript.db-wal transcript.db-shm
```

All three matter: `-wal` holds committed data too, so deleting only the `.db` leaves the
transcript partly recoverable.

## If something looks wrong

**"No input device matching ..."** — the device name must match `devices.py` exactly.
The pipeline prints the available inputs when it can't find yours.

**BlackHole installed but still not listed.** This is the usual trap. CoreAudio only scans
`/Library/Audio/Plug-Ins/HAL/` when its daemon starts, so a driver installed into a running
system is invisible until you restart it:

```bash
sudo killall coreaudiod
```

Audio drops for about a second; no logout or reboot needed. To confirm the driver is
really on disk and see whether the daemon predates it:

```bash
ls /Library/Audio/Plug-Ins/HAL/          # BlackHole2ch.driver should be here
ps -o lstart= -p $(pgrep coreaudiod)     # if this is older than the install, restart it
```

**The viewer sits on "waiting" but the pipeline is running** — it follows the newest
session, and a session is only recorded once it has a real segment, so a run that dies
during startup cannot shadow a good transcript. If it still waits, nobody has spoken yet
(or no audio is reaching BlackHole — check `setup_audio.py status`).

## Tuning

Diarization no longer needs tuning — Sortformer handles the speaker logic itself. The
remaining knobs shape how turns are cut for transcription:

| flag | default | what it does |
|---|---|---|
| `--names` | — | `"Interviewer,Candidate"`, mapped in order of first appearance |
| `--reset` | off | wipe the transcript before starting |
| `--engine` | `crisper` | `crisper` = CrisperWhisper (verbatim); `whisper` = stock OpenAI Whisper (MIT) |
| `--mode` | `verbatim` | CrisperWhisper only: `verbatim` keeps fillers/false starts; `intended` cleans them up |
| `--cw-model` | `medium` | CrisperWhisper size: `medium`, `large`, `turbo`, `small` |
| `--whisper-model` | `openai/whisper-medium` | checkpoint for `--engine whisper` (e.g. `openai/whisper-large-v3`) |
| `--asr-timeout` | `12` | drop a turn if its transcription overruns this many seconds |
| `--sf-threshold` | `0.5` | Sortformer speaker-activity threshold (0–1); rarely touched |
| `--min-turn` | `0.6` | ignore speaker changes until the turn is this long (anti-flicker) |
| `--silence-finalize` | `0.8` | emit a trailing turn this long after everyone goes quiet |
| `--max-turn` | `15` | force a transcription window after this long (long monologues) |
| `--language` | `en` | ISO code (CrisperWhisper is multilingual) |

Notes on the ones that matter:

- **`--engine`** picks the transcriber. `crisper` (default) is the verbatim fine-tune;
  `whisper` is stock OpenAI Whisper via transformers — MIT-licensed, clean text only, and
  it ignores `--mode`/`--cw-model` (use `--whisper-model` instead). Both run fp16 on the
  MPS GPU at a similar speed; the choice is verbatim-disfluencies-plus-licence vs.
  clean-text-and-MIT. Measured RTFs below are for CrisperWhisper.
- **`--mode`** is the CrisperWhisper style (no effect under `--engine whisper`). `verbatim` transcribes exactly what was said,
  including "um", repeats and false starts (and tags non-speech like `[throatclearing]`);
  `intended` gives clean prose. Verbatim is the interesting one for an interview — the
  hesitations are signal — but it's noisier.
- **`--cw-model`** trades speed for quality: `medium` (RTF ~0.13) is the default sweet
  spot; `large` (RTF ~0.20) is a touch better; `turbo` is fastest at large-ish quality.
- **`--min-turn` is anti-flicker.** During crosstalk Sortformer flips between speakers
  rapidly; without this the transcript shatters into one-word fragments. Raise it if you
  see fragmentation, lower it if genuinely short turns are being swallowed.
- **`--asr-timeout`** is a safety net: CrisperWhisper's quality retries can blow up on very
  hard audio, so a turn that overruns the budget is dropped rather than backing up the
  queue.

## Measured on an M3 Max

- Sortformer diarization: **~0.08× realtime** on the MLX GPU — effectively free.
- CrisperWhisper medium: **~0.13× realtime** on the MPS GPU (large ~0.20×). The two GPUs
  paths (MLX-Metal and torch-MPS) run concurrently.
- End of turn → row in the database: **~3 s** typical (diarization has to see the *next*
  speaker start before it can finalise a turn, then transcription runs).

## What this prototype does not do

- **Verbatim overlapping speech.** Sortformer *detects* overlap (which keeps it from
  mislabelling during crosstalk), but the transcript is sequential: when two people talk
  over each other for a sustained stretch, the dominant voice wins and the other's
  concurrent words are lost or fragmented. Truly transcribing two simultaneous voices
  needs source separation, which is out of scope. Brief interjections are absorbed cleanly
  by `--min-turn`.
- **One boundary word can land on the wrong side.** Sortformer marks a speaker's onset a
  beat late, so the first word of a turn occasionally attaches to the previous speaker
  ("…sluggish. And" / "how did you solve it? We"). Cosmetic; the turn itself is correct.
- **Speaker identity across sessions.** `S1`/`Interviewer` in one run is not the same
  person in the next. Enrolling known voices would fix it.
- **No lightweight/CPU transcription option.** Both engines need PyTorch (`--engine
  whisper` is still torch/MPS, not a CPU escape hatch), and a CTranslate2 Whisper
  (faster-whisper) can't coexist with it — torch's OpenMP runtime deadlocks CTranslate2 at
  load, and Sortformer pulls torch in regardless. A CPU-only fallback would have to run as
  a separate process. (`--language` still works — both engines are multilingual.)

## Obvious next step

The Aggregate Device puts system audio on channels 1–2 and your mic on channel 3.
`pipeline.py` currently mixes them to mono. Keeping them separate would give you a
free, perfectly reliable "them vs. me" split, with clustering only needed to separate
the remote participants from each other.
