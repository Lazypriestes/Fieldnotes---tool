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

## systemaudio (ScreenCaptureKit)
Captures macOS **system audio** — or one app's — with **no virtual driver and no output
rerouting**. Your default output and the volume keys are untouched (unlike BlackHole).

```bash
./build.sh                              # compile -> ./systemaudio   (needs swiftc)
./systemaudio                           # all system audio (excludes our own output)
./systemaudio --app "Microsoft Teams"   # only that app's audio (best effort)
./systemaudio | ../.venv/bin/python ../pipeline.py --reset --source stdin --names "Interviewer,Candidate"
```

**Permission:** first run asks for **Screen Recording** for your terminal
(System Settings › Privacy & Security › Screen Recording). One-time, far less invasive
than BlackHole's device rerouting. Until granted, it logs the reason to stderr and exits.

Logs go to **stderr**; stdout is data only.

## In the app
`analysis/assistant.py` launches `systemaudio | pipeline --source stdin` when the ◉ source
dropdown is set to **"System audio (Teams)"**. If the helper isn't built, that source
reports an error and Sample/Microphone still work.

## Swapping the method later
- Different capturer? Emit the contract above and pipe it into `pipeline.py --source stdin`.
- Back to a loopback driver? Use `pipeline.py --source device --device "BlackHole 2ch"`.
- The pipeline never needs to change.
