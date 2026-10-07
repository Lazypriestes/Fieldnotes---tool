"""Live speech-to-text + speaker separation, writing to a local SQLite file.

Diarization is done by NVIDIA Nemotron-3-Diarization (default; up to 8 speakers) or
streaming Sortformer v2.1 (--diarizer sortformer; up to 4), both on MLX / the
Apple-Silicon GPU: one neural net does voice-activity, segmentation and speaker
assignment, and it handles overlapping speech. Parakeet provides the words.

    audio (device, stdin or file)
        -> 1s chunks
        -> diarizer stream     (who spoke, when)         [GPU]
        -> merge into turns
        -> Whisper transcribe   (what they said)         [CPU]
        -> SQLite (WAL; readable live by watch.py / server.py / an LLM)

Two sources:
    --source file   --path sample_interview.wav
    --source device --device "BlackHole 2ch"
"""

import argparse
import signal
import re
import os
import queue
import sys
import threading
import time

# Force HuggingFace's classic (resumable) downloader. Its newer Xet transfer path
# throws "CAS Client Error: error decoding response body" on flaky/slow networks and
# leaves models half-downloaded. Set before any hub import.
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

import numpy as np
import soundfile as sf
import sounddevice as sd
from mlx_audio.vad import load as load_diarizer

from store import Store

SAMPLE_RATE = 16000
BLOCK = 1600                 # 100 ms device blocks
CHUNK_SEC = 1.0              # Sortformer needs ~1 s chunks; smaller yields nothing
CHUNK_SAMPLES = int(SAMPLE_RATE * CHUNK_SEC)
# Diarizer models (both MLX, both loaded via mlx_audio.vad.load):
#   nemotron   — NVIDIA Nemotron-3-Diarization: up to 8 speakers, latency presets (default)
#   sortformer — streaming Sortformer v2.1: up to 4 speakers (previous default; fallback)
DIARIZERS = {
    "nemotron": "mlx-community/Nemotron-3-Diarization",
    "sortformer": "mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16",
}

HERE = os.path.dirname(os.path.abspath(__file__))

audio_q = queue.Queue()      # raw 100 ms float32 blocks
turn_q = queue.Queue()       # (t_start, t_end, speaker_idx, samples) ready to transcribe
stop = threading.Event()
# Off the record: while set, every incoming audio block is replaced by silence BEFORE anything
# else sees it - nothing is diarized, transcribed or stored. Silence (not dropping blocks)
# keeps the timeline continuous. Toggled by the server: SIGUSR1 = off the record, SIGUSR2 = back on.
OFF_RECORD = threading.Event()


def _offrec(block):
    return np.zeros_like(block) if OFF_RECORD.is_set() else block


# --------------------------------------------------------------------------
# transcription engines, behind one interface: samples -> [(start, end, word)]
# --------------------------------------------------------------------------

class _Transcriber:
    """Base: a wall-clock guard shared by every engine.

    Subclasses implement _transcribe(samples) -> list of (start, end, " word")
    tuples with numeric times relative to the clip start (the caller adds the
    absolute offset). Times must never be None -- the ASR worker does arithmetic
    on them.
    """

    def __init__(self, *, timeout):
        self.timeout = timeout

    def _transcribe(self, samples):
        raise NotImplementedError

    def words(self, samples):
        """Transcribe under a wall-clock guard. Returns the word list, or None if it
        overran the budget (the turn is dropped rather than backing up the queue --
        an engine's quality retries can blow up on very hard audio)."""
        out = {}

        def run():
            try:
                out["w"] = self._transcribe(samples)
            except Exception as e:  # noqa: BLE001 - surface, don't crash the worker
                out["err"] = e

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(self.timeout)
        if t.is_alive():
            print(f"[asr] turn dropped: transcription exceeded {self.timeout:.0f}s",
                  file=sys.stderr, flush=True)
            return None
        if "err" in out:
            print(f"[asr] transcription error: {out['err']}", file=sys.stderr, flush=True)
            return []
        return out["w"]


class CrisperTranscriber(_Transcriber):
    """CrisperWhisper (verbatim/intended fine-tune) on the Apple GPU (MPS).

    Two non-obvious requirements, both learned the hard way:
      * force backend="transformers" + device="mps" -- otherwise the package
        auto-selects a CPU CTranslate2 path that is ~20x slower (and device="auto"
        can silently land on CPU too).
      * a CTranslate2-based Whisper (faster-whisper) CANNOT be a fallback in this
        venv: torch ships its own OpenMP runtime and CTranslate2 deadlocks against
        it at load. Since Sortformer (mlx-audio) always pulls torch in, there is no
        room for faster-whisper here. A lighter engine would need its own process.
    """

    def __init__(self, *, language, mode, cw_model, timeout):
        super().__init__(timeout=timeout)
        from crisperwhisper import CrisperWhisperModel
        self.language = language
        self.mode = mode
        self.model = CrisperWhisperModel(cw_model, backend="transformers",
                                         device="mps", compute_type="float16")
        self._transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))   # warm up

    def _transcribe(self, samples):
        r = self.model.transcribe(samples, language=self.language, mode=self.mode,
                                  sr=SAMPLE_RATE, word_timestamps=True)
        # leading space per word so the caller can join with "". r.words is None on silence.
        return [(w.start, w.end, " " + w.word) for w in (r.words or [])]


class WhisperTranscriber(_Transcriber):
    """Stock OpenAI Whisper via HuggingFace transformers on the Apple GPU (MPS).

    The MIT-licensed alternative to CrisperWhisper: same transformers+MPS path (so
    no CTranslate2/OpenMP deadlock), word timestamps, no Nyra license. It does NOT
    reconstruct verbatim disfluencies, so --mode has no effect with this engine.
    """

    def __init__(self, *, language, model, timeout):
        super().__init__(timeout=timeout)
        import torch
        from transformers import pipeline
        from transformers.utils import logging as hf_logging
        hf_logging.set_verbosity_error()   # quiet load/generation warnings
        # language/task are rejected by the English-only (*.en) checkpoints.
        self.gen_kwargs = {"task": "transcribe"}
        if language and not model.endswith(".en"):
            self.gen_kwargs["language"] = language
        # torch_dtype is deprecated in newer transformers, but the replacement
        # dtype= is NOT forwarded by pipeline() in this version -- it silently
        # loads fp32, which is ~2x slower on MPS and overruns the ASR timeout.
        # Keep torch_dtype until pipeline() forwards dtype properly.
        self.pipe = pipeline("automatic-speech-recognition", model=model,
                             torch_dtype=torch.float16, device="mps")
        self._transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))   # warm up

    def _transcribe(self, samples):
        r = self.pipe({"raw": samples, "sampling_rate": SAMPLE_RATE},
                      return_timestamps="word", generate_kwargs=self.gen_kwargs)
        out = []
        for ch in r.get("chunks") or []:
            start, end = ch.get("timestamp") or (None, None)
            if start is None:                    # word the model wouldn't time
                continue
            if end is None:                      # last word sometimes has no end
                end = start
            # normalise to one leading space, matching the Crisper path's convention
            out.append((start, end, " " + ch["text"].strip()))
        return out


class ParakeetTranscriber(_Transcriber):
    """NVIDIA Parakeet on the Apple GPU via MLX (parakeet-mlx) — no PyTorch at runtime.

    Lighter than the Whisper/torch engines (nothing loads a multi-GB torch model into
    unified memory) and cleaner on live/room audio. MIT-friendly. Word timestamps come
    from the model's token alignment, reassembled from SentencePiece subwords.
    """

    def __init__(self, *, model, timeout):
        super().__init__(timeout=timeout)
        # MLX streams are thread-bound, but the base class runs _transcribe in a fresh
        # thread per call. So we own the model in ONE dedicated thread and funnel every
        # request to it — load and inference then always happen on the same thread.
        self._model_name = model
        self._q = queue.Queue()
        self._ready = threading.Event()
        self._load_err = None
        threading.Thread(target=self._serve, daemon=True).start()
        self._ready.wait()
        if self._load_err:
            raise self._load_err

    def _serve(self):
        try:
            import mlx.core as mx
            from parakeet_mlx import from_pretrained
            from parakeet_mlx.audio import get_logmel
            self._mx = mx
            self._logmel = get_logmel
            self.model = from_pretrained(self._model_name)
            self._infer(np.zeros(SAMPLE_RATE, dtype=np.float32))   # warm up on this thread
        except Exception as e:  # noqa: BLE001
            self._load_err = e
        finally:
            self._ready.set()
        while True:
            samples, holder, done = self._q.get()
            try:
                holder["w"] = self._infer(samples)
            except Exception as e:  # noqa: BLE001
                holder["e"] = e
            done.set()

    def _infer(self, samples):
        # raw 16 kHz samples -> log-mel -> generate; skips the model's FFmpeg file loader
        if samples is None or len(samples) < SAMPLE_RATE // 20:     # <50 ms -> nothing
            return []
        audio = self._mx.array(np.asarray(samples, dtype=np.float32))
        mel = self._logmel(audio, self.model.preprocessor_config)
        result = self.model.generate(mel)[0]
        return self._words(result)

    def _transcribe(self, samples):
        holder, done = {}, threading.Event()
        self._q.put((samples, holder, done))
        done.wait()
        if "e" in holder:
            raise holder["e"]
        return holder["w"]

    @staticmethod
    def _words(result):
        """Reassemble subword tokens into words with times. A leading space (or ▁)
        on a token marks a new word; other tokens (incl. punctuation) continue it."""
        out, cur = [], None
        for sent in (getattr(result, "sentences", None) or []):
            for tok in (getattr(sent, "tokens", None) or []):
                txt = getattr(tok, "text", "") or ""
                s = float(getattr(tok, "start", 0.0) or 0.0)
                e = float(getattr(tok, "end", s) or s)
                if txt[:1] in (" ", "▁") or cur is None:  # new word
                    if cur:
                        out.append((cur[0], cur[1], " " + cur[2].strip()))
                    cur = [s, e, txt.replace("▁", " ")]
                else:
                    cur[1] = e; cur[2] += txt
        if cur:
            out.append((cur[0], cur[1], " " + cur[2].strip()))
        return out


# --------------------------------------------------------------------------
# sources  (unchanged: produce 100 ms mono float32 blocks)
# --------------------------------------------------------------------------

def file_source(path, realtime=True):
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    data = data.mean(axis=1)
    if sr != SAMPLE_RATE:
        n = int(len(data) * SAMPLE_RATE / sr)
        data = np.interp(np.linspace(0, len(data), n, endpoint=False),
                         np.arange(len(data)), data).astype(np.float32)
    t0 = time.time()
    for n, i in enumerate(range(0, len(data), BLOCK)):
        if stop.is_set():
            return
        audio_q.put(_offrec(data[i:i + BLOCK].copy()))
        if realtime:
            slack = t0 + (n + 1) * BLOCK / SAMPLE_RATE - time.time()
            if slack > 0:
                time.sleep(slack)


def device_source(device):
    def callback(indata, frames, time_info, status):
        if status:
            print(f"[audio] {status}", file=sys.stderr)
        audio_q.put(_offrec(indata.mean(axis=1).astype(np.float32).copy()))

    with sd.InputStream(device=device, channels=1, samplerate=SAMPLE_RATE,
                        blocksize=BLOCK, dtype="float32", callback=callback):
        print(f"[capture] listening on: {device}   (ctrl-c to stop)", flush=True)
        while not stop.is_set():
            time.sleep(0.1)


def stdin_source(channels=1):
    """Read raw PCM from stdin — the fixed capture contract: 16 kHz, float32,
    little-endian; mono, or with --channels 2 interleaved [microphone, system] frames
    (a call: you on ch0, the other side on ch1). Any external capturer that emits this
    (capture/systemaudio, ffmpeg, etc.) plugs in here without the pipeline knowing how
    audio was grabbed. Decouples the capture *method* from the pipeline."""
    stream = sys.stdin.buffer
    nbytes = BLOCK * 4 * channels            # float32 = 4 bytes/sample
    layout = "mono" if channels == 1 else "2 ch: mic + system"
    print(f"[capture] reading PCM from stdin (16 kHz {layout} f32)   (ctrl-c to stop)", flush=True)
    while not stop.is_set():
        buf = b""
        while len(buf) < nbytes:             # pipes can short-read; fill a full block
            chunk = stream.read(nbytes - len(buf))
            if not chunk:
                break
            buf += chunk
        if not buf:                          # EOF -> capturer ended
            break
        if len(buf) < nbytes:
            buf += b"\x00" * (nbytes - len(buf))
        block = np.frombuffer(buf, dtype="<f4").astype(np.float32)
        audio_q.put(_offrec(block.reshape(-1, channels).copy() if channels > 1 else block.copy()))


def run_source(fn, *args):
    """Guarantee the end-of-stream sentinel, so a bad --device can't hang the pipeline."""
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
            print("\n(no loopback device? install one: brew install blackhole-2ch)",
                  file=sys.stderr, flush=True)
        except Exception:
            pass
        stop.set()
    finally:
        audio_q.put(None)


# --------------------------------------------------------------------------
# diarize: Sortformer stream -> merge frame segments into speaker turns
# --------------------------------------------------------------------------

class RollingBuffer:
    """The audio fed to Sortformer, kept around so we can slice a finished turn out
    of it for Whisper. Bounded so a long call can't grow memory without limit."""

    def __init__(self, keep_sec=45.0):
        self.buf = np.empty(0, dtype=np.float32)
        self.start = 0.0                       # wall-of-stream time of buf[0]
        self.keep = int(keep_sec * SAMPLE_RATE)

    def append(self, chunk):
        self.buf = np.concatenate([self.buf, chunk])
        if len(self.buf) > self.keep:
            drop = len(self.buf) - self.keep
            self.buf = self.buf[drop:]
            self.start += drop / SAMPLE_RATE

    def now(self):
        return self.start + len(self.buf) / SAMPLE_RATE

    def slice(self, t0, t1):
        a = max(0, int((t0 - self.start) * SAMPLE_RATE))
        b = min(len(self.buf), int((t1 - self.start) * SAMPLE_RATE))
        return self.buf[a:b].copy() if b > a else np.empty(0, dtype=np.float32)


PAD = 0.3   # seconds of audio kept around a transcription window


def diarize_worker(diarizer, sf_threshold, max_turn, silence_finalize, min_turn,
                   stream_kwargs=None, frame_sec=None):
    """Run Sortformer, keep a speaker timeline, and dispatch transcription windows
    at silence breaks. We deliberately transcribe on *silence* boundaries, not on
    speaker-change boundaries: cutting audio where a speaker changes clips words and
    bleeds the neighbour in. Whisper then labels each word from the timeline."""
    buffer = RollingBuffer()

    def feeder():
        acc, accn = [], 0
        while True:
            block = audio_q.get()
            if block is None:
                if accn:
                    chunk = np.concatenate(acc)
                    buffer.append(chunk)
                    yield chunk
                return
            acc.append(block)
            accn += len(block)
            if accn >= CHUNK_SAMPLES:
                chunk = np.concatenate(acc)
                buffer.append(chunk)
                yield chunk
                acc, accn = [], 0

    timeline = []          # (start, end, speaker) — every raw Sortformer segment
    transcribe_from = 0.0  # dispatched up to here
    last_end = 0.0         # newest speech offset seen
    cur_spk = None         # speaker of the most recent segment
    frontier = 0.0         # audio time the diarizer has fully processed

    def dispatch(t0, t1):
        if t1 - t0 < 0.2:
            return
        audio_start = max(t0 - PAD, buffer.start)
        audio = buffer.slice(audio_start, t1 + PAD)
        # dominant speaker over the window, by how long each was active in it
        dur = {}
        for s, e, spk in timeline:
            ov = max(0.0, min(e, t1) - max(s, t0))
            if ov > 0:
                dur[spk] = dur.get(spk, 0.0) + ov
        if len(audio) and dur:
            win_spk = max(dur, key=dur.get)
            turn_q.put((audio_start, audio, win_spk, t0, t1))

    for out in diarizer.generate_stream(feeder(), sample_rate=SAMPLE_RATE,
                                        threshold=sf_threshold,
                                        min_duration=0.2, merge_gap=0.0,
                                        **(stream_kwargs or {})):
        if stop.is_set():
            break
        for seg in out.segments:
            # Speaker changed and the current turn is already substantial -> the
            # previous turn is finished, transcribe it now. Requiring min_turn is
            # hysteresis: a brief flicker (a backchannel, or crosstalk during
            # overlap) can't shatter a turn into fragments. End the window at the
            # previous speaker's last offset so padding won't pull the next
            # speaker's first word in. Primary trigger: latency is one turn.
            if (cur_spk is not None and seg.speaker != cur_spk
                    and last_end - transcribe_from >= min_turn):
                dispatch(transcribe_from, last_end)
                transcribe_from = last_end
                cur_spk = seg.speaker
            elif cur_spk is None:
                cur_spk = seg.speaker
            timeline.append((seg.start, seg.end, seg.speaker))
            last_end = max(last_end, seg.end)
        # Nemotron emits ~1 s behind the live audio (chunk + lookahead), so measuring
        # silence against `buffer.now()` makes every chunk look like a pause and chops
        # turns into fragments. For it, measure against how far it has PROCESSED: each
        # result's speaker_probs are contiguous frames of `frame_sec` from t=0.
        if frame_sec:
            frontier += out.speaker_probs.shape[0] * frame_sec
            now = frontier
        else:
            now = buffer.now()
        # secondary triggers: a long monologue (max_turn) or a trailing utterance
        # before a real silence (silence_finalize)
        if last_end > transcribe_from and (now - last_end > silence_finalize
                                           or last_end - transcribe_from >= max_turn):
            dispatch(transcribe_from, last_end)
            transcribe_from = last_end

    if last_end > transcribe_from:
        dispatch(transcribe_from, last_end)
    turn_q.put(None)


# --------------------------------------------------------------------------
# call mode: speaker = channel (mic = you, system = them) — no diarization model
# --------------------------------------------------------------------------

def channel_worker(max_turn, silence_finalize, min_turn, mic_delay=0.2, diarizer=None, split=()):
    """2-channel input [mic, system] -> speaker turns. Who spoke comes from the channel,
    with an ECHO MODEL so sound from your speakers reaching the mic never counts as you:

      * system channel: a clean digital signal, so any real level means it is sounding
        (no learned "silence" level - that broke when a video was already playing at start)
      * echo gain g: how loud the speakers are in your mic relative to the system channel,
        learned continuously (~0.4 on laptop speakers, ~0 with headphones)
      * you are speaking only when the mic is clearly LOUDER than the echo the recent
        system audio could produce - which also lets you talk over the other side
      * every "you" turn is checked once more: if the mic's loudness rises and falls in step
        with the system channel, it is echo and is dropped

    A switch of speaker needs ~0.3 s of the new voice (hysteresis). Each finished turn is
    transcribed from its own clean channel.

    mic_delay: the system-audio tap reaches us ~0.2 s later than the microphone (measured:
    speaker echo hits the mic 209 ms before the same sound arrives on the system channel);
    the mic is delayed by that much so the two channels line up.

    split: channels to ALSO diarize (0 = mic, 1 = system) when more than one person can be on
    a channel - two interviewers in the room (split the mic), or a second interviewer on the
    call (split the system side). One Nemotron model serves both, with a separate streaming
    state per channel. A turn is then cut wherever the speaker inside the channel changes, and
    each piece is labelled with speaker index channel*8 + sub-speaker."""
    from collections import deque
    bufs = [RollingBuffer(), RollingBuffer()]
    lag_blocks = max(0, int(round(mic_delay * SAMPLE_RATE / BLOCK)))
    mic_fifo = deque([np.zeros(BLOCK, np.float32)] * lag_blocks)
    BLOCK_SEC = BLOCK / SAMPLE_RATE
    SYS_ON = 0.004                       # system channel is sounding
    MIC_MIN = 0.006                      # quietest mic level that can be a voice
    mic_floor = 0.002                    # mic room-noise level (adapts)
    echo = {"g": 0.6, "num": 0.0, "den": 0.0, "n": 0}   # echo gain mic/system: cautious start, then learned
    sys_hist = deque(maxlen=7)           # last 0.7 s of system levels: echo tail + misalignment
    cur = None                           # speaker of the current turn (0 = mic, 1 = system)
    turn_from = turn_last = 0.0          # current turn: start / last voiced moment
    cand, cand_since = None, 0.0         # a would-be new speaker and since when
    t = 0.0
    dropped = [0]
    states = {c: diarizer.init_streaming_state() for c in split} if diarizer else {}
    timelines = {c: [] for c in states}  # (start, end, sub-speaker) per split channel

    def pieces(c, t0, t1):
        """Cut [t0, t1] where the speaker inside channel c changes; blips < 0.6 s are absorbed."""
        segs = sorted((max(a, t0), min(b, t1), k) for a, b, k in timelines.get(c, []) if b > t0 and a < t1)
        out = []
        for a, b, k in segs:
            if out and out[-1][2] == k:
                out[-1][1] = max(out[-1][1], b)
            elif b - a >= 0.6 or not out:
                out.append([a, b, k])
            else:
                out[-1][1] = max(out[-1][1], b)
        if not out:
            return [(t0, t1, 0)]
        out[0][0], out[-1][1] = t0, t1
        for i in range(1, len(out)):
            # Nemotron marks a new speaker's onset ~0.3 s late; move the cut back into the
            # pause so the newcomer's first word isn't left on the previous speaker's line
            out[i][0] = max(out[i - 1][0] + 0.3, out[i][0] - 0.35)
            out[i - 1][1] = out[i][0]         # no gaps: each piece runs until the next begins
        return [tuple(x) for x in out]

    def envelope(x, frame=320):          # 20 ms loudness frames
        n = len(x) // frame
        return np.sqrt(np.mean(x[: n * frame].reshape(n, frame) ** 2, axis=1)) if n else np.empty(0)

    def is_echo(t0, t1):
        """Does the mic's loudness over this turn track the system channel (within +-0.4 s)?"""
        em = envelope(bufs[0].slice(t0, t1))
        es = envelope(bufs[1].slice(t0 - 0.4, t1 + 0.4))
        if len(em) < 10 or len(es) < len(em) or es.max() < SYS_ON or em.std() == 0:
            return False
        best = 0.0
        for lag in range(0, len(es) - len(em) + 1):
            w = es[lag: lag + len(em)]
            if w.std() > 0:
                best = max(best, float(np.corrcoef(em, w)[0, 1]))
        return best > 0.6

    def dispatch(ch, t0, t1):
        if t1 - t0 < 0.25:
            return
        if ch == 0 and is_echo(t0, t1):
            dropped[0] += 1
            print(f"[call] dropped {t1 - t0:.1f}s of speaker echo on the mic", flush=True)
            return
        for a, b, sub in (pieces(ch, t0, t1) if ch in states else [(t0, t1, 0)]):
            a0 = max(a - PAD, bufs[ch].start)
            audio = bufs[ch].slice(a0, b + PAD)
            if len(audio):
                turn_q.put((a0, audio, ch * 8 + sub, a, b))

    while True:
        block = audio_q.get()
        if block is None or stop.is_set():
            break
        mic_fifo.append(block[:, 0].copy())
        mic, sys_ = mic_fifo.popleft(), block[:, 1]
        if len(mic) != len(sys_):              # a short last block
            mic = np.resize(mic, len(sys_))
        bufs[0].append(mic); bufs[1].append(sys_)
        for c in states:                      # who is speaking INSIDE a shared channel
            res, states[c] = diarizer.feed(mic if c == 0 else sys_, states[c], SAMPLE_RATE,
                                           threshold=0.5, min_duration=0.2)
            timelines[c].extend((g.start, g.end, g.speaker) for g in res.segments)
            keep_from = bufs[c].start
            if timelines[c] and timelines[c][0][1] < keep_from:
                timelines[c] = [g for g in timelines[c] if g[1] >= keep_from]
        rm = float(np.sqrt(np.mean(mic ** 2)))
        rs = float(np.sqrt(np.mean(sys_ ** 2)))
        sys_hist.append(rs)
        recent = max(sys_hist)
        mic_floor = rm if rm < mic_floor else mic_floor * 1.005 + 1e-7
        voice = rm > max(4.0 * mic_floor, MIC_MIN)
        you = voice and rm > 2.5 * echo["g"] * recent + 0.004     # louder than echo can explain
        them = rs > SYS_ON
        if rs > 0.02 and not you:
            # learn the echo gain as a ratio of AVERAGE levels (mic vs system on the same,
            # aligned blocks) - dividing by the recent PEAK underestimated it 2-3x and let
            # echo through. Blocks where the mic is far above the current estimate are
            # skipped: that's you talking over them, not echo.
            if echo["n"] < 10 or rm < 2.0 * echo["g"] * rs + 0.01:
                echo["num"] = 0.97 * echo["num"] + 0.03 * rm
                echo["den"] = 0.97 * echo["den"] + 0.03 * rs
                echo["n"] += 1
                if echo["n"] >= 10:
                    echo["g"] = min(1.5, max(0.02, echo["num"] / echo["den"]))
        spk = 0 if you else 1 if them else None
        t_end = t + BLOCK_SEC
        if spk is not None:
            if cur is None:
                cur, turn_from, turn_last, cand = spk, t, t_end, None
            elif spk == cur:
                turn_last, cand = t_end, None
            else:
                if cand != spk:
                    cand, cand_since = spk, t
                if t_end - cand_since >= 0.3:
                    if turn_last - turn_from >= min_turn:      # a real turn ended: hand over
                        dispatch(cur, turn_from, turn_last)
                        turn_from = cand_since
                    # else: the current "turn" was only a blip (often speaker echo reaching
                    # the mic first) - relabel it to the new speaker rather than blocking them
                    cur, turn_last, cand = spk, t_end, None
        if cur is not None and (t_end - turn_last > silence_finalize or turn_last - turn_from >= max_turn):
            dispatch(cur, turn_from, turn_last)
            cur, cand = None, None
        t = t_end
    if cur is not None:
        dispatch(cur, turn_from, turn_last)
    turn_q.put(None)


# --------------------------------------------------------------------------
# transcribe finished turns + persist
# --------------------------------------------------------------------------

def asr_worker(transcriber, store, session_id, names, fixed_names=False):
    label_map, order = {}, []
    # newest word time already stored, for cross-window dedup. One timeline normally; in
    # call mode one PER CHANNEL - the two channels are separate recordings, so a word on
    # one must never be dropped as a "repeat" of the other speaker's last word.
    emitted_until = {}
    last_words = {}        # per channel: (end, word) of the last few words emitted

    def _norm(w):
        return re.sub(r"[^a-z0-9']", "", w.lower())

    def name_for(spk_idx):
        if callable(fixed_names):   # call mode: the label comes from channel + sub-speaker
            return fixed_names(spk_idx)
        if fixed_names:      # call mode: speaker index IS the channel -> names[0] = mic, names[1] = system
            return names[spk_idx] if spk_idx < len(names) else f"S{spk_idx + 1}"
        raw = f"S{spk_idx + 1}"
        if raw not in label_map:
            order.append(raw)
            i = len(order) - 1
            label_map[raw] = names[i] if i < len(names) else raw
        return label_map[raw]

    def emit(spk_idx, t0, t1, text):
        if spk_idx is None or not text.strip():
            return
        speaker = name_for(spk_idx)
        store.add_segment(session_id, t0, t1, speaker, text.strip())
        lag = time.time() - START_WALL - t1
        print(f"[{t0:6.1f}s] {speaker:<12} {text.strip()}", flush=True)
        print(f"           \033[2mspk={spk_idx}  lag={lag:+.1f}s\033[0m", flush=True)

    while True:
        item = turn_q.get()
        if item is None:
            break
        audio_start, samples, win_spk, win_t0, win_t1 = item
        key = (win_spk // 8 if callable(fixed_names) else win_spk) if fixed_names else 0   # per channel

        raw = transcriber.words(samples)
        if not raw:                       # None (timed out) or [] (empty/error)
            continue
        words = [(audio_start + s, audio_start + e, w) for s, e, w in raw]

        # This window is one speaker turn. Keep its words: front padding is generous
        # (Sortformer marks a speaker's onset a touch late, so real first words sit
        # just before win_t0); the tail is tight so the next speaker isn't pulled in;
        # and nothing already emitted by an earlier window repeats.
        keep = [w for w in words
                if (w[0] + w[1]) / 2 >= win_t0 - 0.35
                and (w[0] + w[1]) / 2 <= win_t1 + 0.05
                and (w[0] + w[1]) / 2 > emitted_until.get(key, 0.0)]
        # A turn cut between two speakers of the SAME channel: the word at the cut can be heard
        # by both halves, with slightly different timings. Drop a leading word that repeats the
        # previous piece's last word(s) from this channel within 0.8 s.
        prev = last_words.get(key, [])
        while keep and prev and any(_norm(keep[0][2]) == wtxt and abs(keep[0][0] - wend) < 0.8
                                    for wend, wtxt in prev):
            keep = keep[1:]
        if not keep:
            continue
        last_words[key] = [(w[1], _norm(w[2])) for w in keep[-3:]]
        emitted_until[key] = max(w[1] for w in keep)
        emit(win_spk, keep[0][0], keep[-1][1], "".join(w[2] for w in keep))


# --------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", choices=["file", "device", "stdin"], default="file")
    p.add_argument("--path", default=os.path.join(HERE, "sample_interview.wav"))
    p.add_argument("--device", default=None, help="input device name or index")
    p.add_argument("--fast", action="store_true",
                   help="file source: process as fast as possible, don't pace to realtime")
    p.add_argument("--db", default=os.path.join(HERE, "transcript.db"))
    p.add_argument("--reset", action="store_true",
                   help="delete the transcript database before starting")
    p.add_argument("--engine", choices=["parakeet", "crisper", "whisper"], default="parakeet",
                   help="parakeet = NVIDIA Parakeet on MLX (default; light on RAM, no torch model); "
                        "crisper = CrisperWhisper verbatim fine-tune; "
                        "whisper = stock OpenAI Whisper (MIT, ignores --mode)")
    p.add_argument("--parakeet-model", default="mlx-community/parakeet-tdt-0.6b-v2",
                   help="parakeet-mlx checkpoint for --engine parakeet")
    p.add_argument("--mode", choices=["verbatim", "intended"], default="verbatim",
                   help="CrisperWhisper only: verbatim keeps fillers/false starts; "
                        "intended cleans them up")
    p.add_argument("--cw-model", default="medium",
                   help="CrisperWhisper size: medium (default), large, turbo, small")
    p.add_argument("--whisper-model", default="openai/whisper-medium",
                   help="stock Whisper checkpoint for --engine whisper "
                        "(e.g. openai/whisper-large-v3)")
    p.add_argument("--asr-timeout", type=float, default=12.0,
                   help="drop a turn if its transcription exceeds this many seconds")
    p.add_argument("--language", default="en", help="ISO code")
    p.add_argument("--names", default="", help='e.g. "Interviewer,Candidate"')
    p.add_argument("--sf-threshold", type=float, default=0.5,
                   help="Sortformer speaker-activity threshold (0..1)")
    p.add_argument("--max-turn", type=float, default=15.0,
                   help="force a transcription window after this many seconds")
    p.add_argument("--silence-finalize", type=float, default=0.8,
                   help="transcribe a window this long after everyone goes quiet")
    p.add_argument("--min-turn", type=float, default=0.6,
                   help="ignore speaker changes until the current turn is this long "
                        "(hysteresis against flicker/crosstalk)")
    p.add_argument("--channels", type=int, choices=[1, 2], default=1,
                   help="stdin only: 2 = a call captured as [mic, system] (capture/systemaudio "
                        "--with-mic). Speakers then come from the channel; no diarizer is loaded.")
    p.add_argument("--split", choices=["none", "mic", "system", "both"], default="none",
                   help="call mode: also tell apart several people on one channel - 'mic' when "
                        "two interviewers share the room, 'system' when a second interviewer "
                        "joins the call remotely ('Remote 1', 'Remote 2', ...)")
    p.add_argument("--mic-delay", type=float, default=0.2,
                   help="call mode: delay the mic channel by this many seconds to line it up with "
                        "the (slower) system-audio channel")
    p.add_argument("--diarizer", choices=sorted(DIARIZERS), default="nemotron",
                   help="nemotron (8 speakers, default) or sortformer (4 speakers, previous)")
    p.add_argument("--latency", choices=["ultra_low", "very_low", "low"], default="low",
                   help="Nemotron streaming preset: 0.32 / 0.64 / 1.04 s input latency "
                        "(lower = snappier, slightly less accurate)")
    # accepted for backward compatibility with older run.sh; the diarizer sets the cap.
    p.add_argument("--max-speakers", type=int, default=4, help=argparse.SUPPRESS)
    args = p.parse_args()

    global START_WALL
    names = [n.strip() for n in args.names.split(",") if n.strip()]

    if args.reset:
        removed = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(args.db + suffix)
                removed += 1
            except FileNotFoundError:
                pass
        print(f"[reset] deleted {removed} file(s) for {os.path.basename(args.db)}")

    if args.engine == "parakeet":
        print(f"[init] loading Parakeet {args.parakeet_model} (Apple GPU / MLX) "
              f"— first run downloads the model, then warms up...")
        transcriber = ParakeetTranscriber(model=args.parakeet_model, timeout=args.asr_timeout)
    elif args.engine == "whisper":
        print(f"[init] loading Whisper {args.whisper_model} (Apple GPU) "
              f"— first run downloads the model, then warms up...")
        transcriber = WhisperTranscriber(language=args.language,
                                         model=args.whisper_model,
                                         timeout=args.asr_timeout)
    else:
        print(f"[init] loading CrisperWhisper {args.cw_model} ({args.mode}, Apple GPU) "
              f"— first run downloads the model, then warms up...")
        transcriber = CrisperTranscriber(language=args.language, mode=args.mode,
                                         cw_model=args.cw_model, timeout=args.asr_timeout)
    call_mode = args.source == "stdin" and args.channels == 2
    diarizer, stream_kwargs, frame_sec = None, {}, None
    split = {"none": (), "mic": (0,), "system": (1,), "both": (0, 1)}[args.split] if call_mode else ()
    if call_mode:
        print("[init] call mode: you = microphone channel, them = system-audio channel"
              + (f" + speaker split on {args.split}" if split else " (no diarization model needed)"))
        if split:
            diarizer = load_diarizer(DIARIZERS["nemotron"])
            diarizer.set_streaming_config(args.latency)
    elif args.diarizer == "nemotron":
        print(f"[init] loading Nemotron-3-Diarization ({args.latency} latency; "
              f"first run downloads ~200 MB)...")
        diarizer = load_diarizer(DIARIZERS["nemotron"])
        # The model ships on the 'offline' preset (~27 s chunks) — fatal for live use.
        diarizer.set_streaming_config(args.latency)
        stream_kwargs, frame_sec = {}, 0.01      # speaker_probs at 10 ms resolution
    else:
        print("[init] loading Sortformer (first run downloads ~230 MB)...")
        diarizer = load_diarizer(DIARIZERS["sortformer"])
        stream_kwargs, frame_sec = {"chunk_duration": CHUNK_SEC}, None

    store = Store(args.db)
    src = args.path if args.source == "file" else "stdin" if args.source == "stdin" else str(args.device)
    session_id = store.start_session(f"{args.source}:{src}")
    print(f"[init] session {session_id} -> {args.db}\n")

    START_WALL = time.time()

    def _set_offrec(on):
        (OFF_RECORD.set if on else OFF_RECORD.clear)()
        print("[off-record] " + ("paused - nothing is transcribed" if on else "back on the record"), flush=True)
    signal.signal(signal.SIGUSR1, lambda *_: _set_offrec(True))
    signal.signal(signal.SIGUSR2, lambda *_: _set_offrec(False))
    if call_mode:
        names = names or ["Interviewer", "Candidate"]
        names += ["Candidate"] * (2 - len(names))

        order = {0: [], 1: []}               # sub-speakers in the order they first SPEAK

        def call_label(spk):
            ch, sub = divmod(spk, 8)
            if sub not in order[ch]:          # a stray blip the model numbered never shows up
                order[ch].append(sub)
            rank = order[ch].index(sub)
            if ch == 0:                       # mic side: the interviewer(s) in the room
                return names[0] if rank == 0 else f"{names[0]} {rank + 1}"
            if 1 in split:                    # call side split: roles assigned later (talk time / UI)
                return f"Remote {rank + 1}"
            return names[1]

        speaker_thread = threading.Thread(target=channel_worker,
                                          args=(args.max_turn, args.silence_finalize, args.min_turn,
                                                args.mic_delay, diarizer, split),
                                          daemon=True)
    else:
        speaker_thread = threading.Thread(target=diarize_worker,
                                          args=(diarizer, args.sf_threshold, args.max_turn,
                                                args.silence_finalize, args.min_turn, stream_kwargs, frame_sec),
                                          daemon=True)
    threads = [
        speaker_thread,
        threading.Thread(target=asr_worker,
                         args=(transcriber, store, session_id, names, call_label if call_mode else False),
                         daemon=True),
    ]
    if args.source == "file":
        threads.append(threading.Thread(
            target=run_source, args=(file_source, args.path, not args.fast), daemon=True))
    elif args.source == "stdin":
        threads.append(threading.Thread(target=run_source, args=(stdin_source, args.channels), daemon=True))
    else:
        threads.append(threading.Thread(
            target=run_source, args=(device_source, args.device), daemon=True))

    for t in threads:
        t.start()
    try:
        threads[2].join()   # source
        threads[0].join()   # diarize
        threads[1].join()   # asr (tail of the chain)
    except KeyboardInterrupt:
        print("\n[stop] draining...")
        stop.set()
        audio_q.put(None)
        threads[0].join(timeout=15)
        threads[1].join(timeout=60)

    n = len(store.since(session_id))
    print(f"\n[done] {n} segments -> {args.db}")
    print(f"[done] read it live with:  python watch.py --db {args.db}")
    store.close()


if __name__ == "__main__":
    main()
