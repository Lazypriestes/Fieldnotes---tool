"""Isolated test of MLX Sortformer streaming diarization. Does NOT touch the pipeline."""
import sys, time
import numpy as np
import soundfile as sf
from mlx_audio.vad import load

wav = sys.argv[1] if len(sys.argv) > 1 else "sample_interview.wav"

print(f"[load] mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16 ...", flush=True)
t0 = time.time()
model = load("mlx-community/diar_streaming_sortformer_4spk-v2.1-fp16")
print(f"[load] ready in {time.time()-t0:.1f}s", flush=True)

dur = len(sf.read(wav)[0]) / sf.read(wav)[1] if False else None
data, sr = sf.read(wav)
dur = len(data) / sr
print(f"[audio] {wav}  {dur:.1f}s @ {sr}Hz\n", flush=True)

print("[diarize] streaming, chunk=5s ...", flush=True)
t0 = time.time()
segs = []
for result in model.generate_stream(wav, chunk_duration=5.0):
    for seg in result.segments:
        segs.append((seg.start, seg.end, seg.speaker))
el = time.time() - t0

print(f"\n[result] {len(segs)} segments in {el:.1f}s  (RTF {el/dur:.2f})")
speakers = sorted(set(s[2] for s in segs))
print(f"[result] speakers: {speakers}\n")
for a, b, spk in segs:
    print(f"  {a:6.2f} -> {b:6.2f}   speaker {spk}")
