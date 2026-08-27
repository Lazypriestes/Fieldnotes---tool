"""Live speech-to-text + speaker separation, writing to a local SQLite file.

    audio (device or file)
        -> VAD          (silero, cheap, keeps up with realtime)
        -> queue
        -> worker       (whisper transcribe + speaker embed + cluster)
        -> SQLite       (WAL; readable live by watch.py or an LLM)

Two sources:
    --source file   --path sample_interview.wav
    --source device --device "BlackHole 2ch"
"""

import argparse
import os
import queue
import sys
import threading
import time

import numpy as np
import sherpa_onnx
import soundfile as sf
import sounddevice as sd
from faster_whisper import WhisperModel

from diarize import OnlineDiarizer
from store import Store

SAMPLE_RATE = 16000
VAD_WINDOW = 512          # silero's frame size at 16 kHz
BLOCK = 1600              # 100 ms capture blocks

# Defaults resolve against this file, not the shell's working directory, so the
# commands work from anywhere. An explicit --flag is still taken as you type it.
HERE = os.path.dirname(os.path.abspath(__file__))

audio_q = queue.Queue()   # raw float32 blocks
seg_q = queue.Queue()     # (t_start, t_end, samples)
stop = threading.Event()


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------

def file_source(path, realtime=True):
    """Stream a wav/mp3/mp4-audio file, optionally pacing it like a live call."""
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    data = data.mean(axis=1)                       # mix to mono
    if sr != SAMPLE_RATE:                          # linear resample, good enough
        n = int(len(data) * SAMPLE_RATE / sr)
        data = np.interp(
            np.linspace(0, len(data), n, endpoint=False),
            np.arange(len(data)),
            data,
        ).astype(np.float32)
    # Pace against an absolute deadline. Sleeping BLOCK/SAMPLE_RATE per
    # iteration would drift slower than realtime and show up as fake lag.
    t0 = time.time()
    for n, i in enumerate(range(0, len(data), BLOCK)):
        if stop.is_set():
            return
        audio_q.put(data[i:i + BLOCK].copy())
        if realtime:
            deadline = t0 + (n + 1) * BLOCK / SAMPLE_RATE
            slack = deadline - time.time()
            if slack > 0:
                time.sleep(slack)


def device_source(device):
    """Capture from an input device. Point this at a loopback device to hear a call."""
    def callback(indata, frames, time_info, status):
        if status:
            print(f"[audio] {status}", file=sys.stderr)
        audio_q.put(indata.mean(axis=1).astype(np.float32).copy())

    with sd.InputStream(device=device, channels=1, samplerate=SAMPLE_RATE,
                        blocksize=BLOCK, dtype="float32", callback=callback):
        print(f"[capture] listening on: {device}   (ctrl-c to stop)", flush=True)
        while not stop.is_set():
            time.sleep(0.1)


def run_source(fn, *args):
    """Whatever happens, downstream has to get its end-of-stream sentinel.
    Without this a failure here (bad --device, missing file) kills only this
    thread and the VAD thread blocks on an empty queue forever, so the process
    hangs with no error instead of exiting."""
    try:
        fn(*args)
    except Exception as e:
        print(f"\n[audio] cannot open source: {type(e).__name__}: {e}",
              file=sys.stderr, flush=True)
        try:
            print("\navailable input devices:", file=sys.stderr)
            for i, d in enumerate(sd.query_devices()):
                if d["max_input_channels"]:
                    print(f"  {i}  {d['name']}", file=sys.stderr)
            print("\n(no loopback device listed? install one: brew install blackhole-2ch)",
                  file=sys.stderr, flush=True)
        except Exception:
            pass
        stop.set()
    finally:
        audio_q.put(None)


# --------------------------------------------------------------------------
# stage 1: voice activity detection -> utterance segments
# --------------------------------------------------------------------------

def vad_worker(vad_model, min_silence, max_speech, vad_threshold):
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = vad_model
    cfg.silero_vad.threshold = vad_threshold
    cfg.silero_vad.min_silence_duration = min_silence
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.max_speech_duration = max_speech
    cfg.sample_rate = SAMPLE_RATE
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)

    buf = np.empty(0, dtype=np.float32)
    ended = False

    def drain():
        while not vad.empty():
            s = vad.front
            t0 = s.start / SAMPLE_RATE
            samples = np.array(s.samples, dtype=np.float32)
            seg_q.put((t0, t0 + len(samples) / SAMPLE_RATE, samples))
            vad.pop()

    while not ended and not stop.is_set():
        block = audio_q.get()
        if block is None:
            ended = True
        else:
            buf = np.concatenate([buf, block])
            while len(buf) >= VAD_WINDOW:
                vad.accept_waveform(buf[:VAD_WINDOW])
                buf = buf[VAD_WINDOW:]
            drain()

    vad.flush()
    drain()
    seg_q.put(None)


# --------------------------------------------------------------------------
# stage 2: transcribe + identify speaker + persist
# --------------------------------------------------------------------------

def asr_worker(asr, diarizer, store, session_id, names, min_seg):
    label_map, order = {}, []
    while True:
        item = seg_q.get()
        if item is None:
            break
        t0, t1, samples = item
        if t1 - t0 < min_seg:
            continue

        segments, _ = asr.transcribe(samples, language=LANGUAGE, beam_size=1,
                                     condition_on_previous_text=False)
        text = " ".join(s.text for s in segments).strip()
        if not text:
            continue

        raw_label, score = diarizer.assign(samples)

        # optional friendly names, assigned in order of first appearance
        if raw_label not in label_map:
            order.append(raw_label)
            idx = len(order) - 1
            label_map[raw_label] = names[idx] if idx < len(names) else raw_label
        speaker = label_map[raw_label]

        store.add_segment(session_id, t0, t1, speaker, text)
        lag = time.time() - START_WALL - t1
        print(f"[{t0:6.1f}s] {speaker:<12} {text}", flush=True)
        print(f"           \033[2msim={score:.2f}  lag={lag:+.1f}s\033[0m", flush=True)


# --------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", choices=["file", "device"], default="file")
    p.add_argument("--path", default=os.path.join(HERE, "sample_interview.wav"))
    p.add_argument("--device", default=None, help="input device name or index")
    p.add_argument("--fast", action="store_true",
                   help="file source: process as fast as possible, don't pace to realtime")
    p.add_argument("--db", default=os.path.join(HERE, "transcript.db"))
    p.add_argument("--reset", action="store_true",
                   help="delete the transcript database before starting")
    p.add_argument("--whisper", default="small.en",
                   help="the .en models are English-only; drop the suffix "
                        "(e.g. 'small') for any other language")
    p.add_argument("--language", default="en",
                   help="ISO code, e.g. de. Needs a multilingual --whisper model")
    p.add_argument("--vad-model",
                   default=os.path.join(HERE, "models", "silero_vad.onnx"))
    p.add_argument("--speaker-model",
                   default=os.path.join(
                       HERE, "models",
                       "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"))
    p.add_argument("--threshold", type=float, default=0.55,
                   help="cosine similarity below this opens a new speaker")
    p.add_argument("--max-speakers", type=int, default=8)
    p.add_argument("--names", default="", help='e.g. "Interviewer,Candidate"')
    p.add_argument("--vad-threshold", type=float, default=0.5,
                   help="speech probability to count as speech; raise it on a noisy "
                        "input or turns never split and diarization sees one speaker")
    p.add_argument("--min-silence", type=float, default=0.35,
                   help="seconds of silence that ends a turn")
    p.add_argument("--max-speech", type=float, default=20.0,
                   help="force-cut a turn after this many seconds")
    p.add_argument("--min-segment", type=float, default=0.4,
                   help="drop segments shorter than this")
    args = p.parse_args()

    global START_WALL, LANGUAGE
    LANGUAGE = args.language
    names = [n.strip() for n in args.names.split(",") if n.strip()]

    if args.whisper.endswith(".en") and args.language != "en":
        print(f"[warn] --whisper {args.whisper} is English-only but --language is "
              f"'{args.language}'.\n"
              f"       Use a multilingual model, e.g. --whisper "
              f"{args.whisper[:-3]}", file=sys.stderr)

    if args.reset:
        # -wal and -shm hold committed data too; removing only the .db file would
        # leave the transcript partly recoverable and confuse the next open.
        removed = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(args.db + suffix)
                removed += 1
            except FileNotFoundError:
                pass
        print(f"[reset] deleted {removed} file(s) for {os.path.basename(args.db)}")

    print("[init] loading models...")
    asr = WhisperModel(args.whisper, device="cpu", compute_type="int8")
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=args.speaker_model, num_threads=2)
    )
    diarizer = OnlineDiarizer(extractor, threshold=args.threshold,
                              max_speakers=args.max_speakers)
    store = Store(args.db)
    source_desc = args.path if args.source == "file" else str(args.device)
    session_id = store.start_session(f"{args.source}:{source_desc}")
    print(f"[init] session {session_id} -> {args.db}\n")

    START_WALL = time.time()
    threads = [
        threading.Thread(target=vad_worker,
                         args=(args.vad_model, args.min_silence, args.max_speech,
                               args.vad_threshold),
                         daemon=True),
        threading.Thread(target=asr_worker,
                         args=(asr, diarizer, store, session_id, names,
                               args.min_segment),
                         daemon=True),
    ]
    if args.source == "file":
        threads.append(threading.Thread(
            target=run_source, args=(file_source, args.path, not args.fast),
            daemon=True))
    else:
        threads.append(threading.Thread(
            target=run_source, args=(device_source, args.device), daemon=True))

    for t in threads:
        t.start()
    try:
        # source and vad finish on their own; the asr worker is the tail of the chain
        threads[2].join()
        threads[0].join()
        threads[1].join()
    except KeyboardInterrupt:
        print("\n[stop] draining...")
        stop.set()
        audio_q.put(None)
        threads[0].join(timeout=10)
        threads[1].join(timeout=60)

    n = len(store.since(session_id))
    print(f"\n[done] {n} segments, {len(diarizer.centroids)} speakers -> {args.db}")
    print(f"[done] read it live with:  python watch.py --db {args.db}")
    store.close()


if __name__ == "__main__":
    main()
