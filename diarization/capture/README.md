# capture/ — pluggable audio capture (BlackHole-free)

A **separate, swappable module** for grabbing audio into the pipeline. It exists so the
*capture method* is decoupled from the diarization pipeline: the helper emits a fixed
**contract** on stdout and the pipeline reads it via `--source stdin`. Swap the helper
(or drop the module entirely and use `--source device` / BlackHole) without touching the
pipeline.

## The contract
```
raw PCM · 16 kHz · mono · float32 · little-endian   →  stdout
```
Anything that emits this works: this `systemaudio` helper, an `ffmpeg` command, a future
Core-Audio-tap tool, etc.

## systemaudio (Core Audio process tap)
Captures macOS **system audio** — or one app's — with **no virtual driver and no output
rerouting**. Your default output and the volume keys are untouched (unlike BlackHole).
Uses the `AudioHardwareCreateProcessTap` API (macOS **14.4+**). An earlier ScreenCaptureKit
version is gone: its audio tap returned no buffers on macOS 26.

`build.sh` produces **SystemAudio.app** (a real bundle with a stable id) and symlinks it as
`./systemaudio`, so any permission grant is tied to the bundle and survives rebuilds.

```bash
./build.sh                              # compile -> SystemAudio.app (+ ./systemaudio symlink); needs swiftc
./systemaudio                           # all system audio
./systemaudio --app "Microsoft Teams"   # only that app's audio (matches on bundle id)
./systemaudio | ../.venv/bin/python ../pipeline.py --reset --source stdin --names "Interviewer,Candidate"
./systemaudio --with-mic | ../.venv/bin/python ../pipeline.py --reset --source stdin --channels 2   # a call
```

**Permission:** if macOS prompts, allow **audio recording** for *Fieldnotes System Audio*
(System Settings › Privacy & Security). No Screen-Recording grant and no loopback device —
far less invasive than BlackHole. On failure it logs the reason to stderr and exits.

Logs go to **stderr**; stdout is data only.

## Call mode (`--with-mic`)
Emits **2 channels** — `[microphone, system]` interleaved, 16 kHz float32 — instead of mono.
`pipeline.py --channels 2` then takes the speaker from the channel (mic = you, system =
them) and skips the diarizer entirely. Whenever the system channel is active it wins, so
speaker echo picked up by the mic never counts as you. Needs Microphone access for
*Fieldnotes System Audio*.

## In the app
`analysis/assistant.py` launches `systemaudio | pipeline --source stdin` when the ◉ source
dropdown is set to **"System audio (Teams)"**. If the helper isn't built, that source
reports an error and Sample/Microphone still work.

## Swapping the method later
- Different capturer? Emit the contract above and pipe it into `pipeline.py --source stdin`.
- Back to a loopback driver? Use `pipeline.py --source device --device "BlackHole 2ch"`.
- The pipeline never needs to change.
