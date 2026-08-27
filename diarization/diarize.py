"""Online speaker assignment.

Not full diarization: this labels one speaker per VAD segment (a "turn"),
which is what a meeting transcript needs anyway. It cannot split a segment
where two people talk over each other.

Method: embed the segment, compare against running centroids, assign to the
nearest one above a cosine threshold, otherwise open a new speaker.
"""

import numpy as np


class OnlineDiarizer:
    def __init__(self, extractor, threshold=0.55, max_speakers=8,
                 min_update_sec=1.0, min_new_speaker_sec=1.0, sample_rate=16000):
        self.extractor = extractor
        self.threshold = threshold
        self.max_speakers = max_speakers
        self.min_update_sec = min_update_sec
        self.min_new_speaker_sec = min_new_speaker_sec
        self.sample_rate = sample_rate
        self.centroids = []   # list of unit-norm np arrays
        self.weights = []     # accumulated seconds behind each centroid

    def _embed(self, samples):
        stream = self.extractor.create_stream()
        stream.accept_waveform(sample_rate=self.sample_rate, waveform=samples)
        stream.input_finished()
        vec = np.array(self.extractor.compute(stream), dtype=np.float32)
        norm = np.linalg.norm(vec)
        return vec / norm if norm > 0 else vec

    def assign(self, samples):
        """Return (speaker_label, confidence)."""
        duration = len(samples) / self.sample_rate
        emb = self._embed(samples)

        if not self.centroids:
            self.centroids.append(emb)
            self.weights.append(duration)
            return "S1", 1.0

        sims = np.array([float(c @ emb) for c in self.centroids])
        best = int(np.argmax(sims))
        score = float(sims[best])

        # A sub-second fragment ("Sure.", "Mhm.") does not carry a reliable
        # embedding, so it may join an existing speaker but never invent one --
        # otherwise every backchannel spawns a phantom speaker.
        can_open = (duration >= self.min_new_speaker_sec
                    and len(self.centroids) < self.max_speakers)
        if score < self.threshold and can_open:
            self.centroids.append(emb)
            self.weights.append(duration)
            return f"S{len(self.centroids)}", score

        # Only let confident, reasonably long turns move a centroid, so a
        # short "mhm" or a crosstalk segment can't drag a speaker's identity.
        if duration >= self.min_update_sec and score >= self.threshold:
            w = self.weights[best]
            merged = (self.centroids[best] * w + emb * duration) / (w + duration)
            self.centroids[best] = merged / np.linalg.norm(merged)
            self.weights[best] = min(w + duration, 120.0)  # cap so it stays adaptive

        return f"S{best + 1}", score
