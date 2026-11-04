"""Mic echo removal with the call track as reference: WebRTC AEC3 (livekit's AudioProcessingModule,
10 ms frames, 16 kHz mono), the canceller Teams/Chrome use, run outside the call app.

  ~/.cache/relay-meetings-spike/.venv/bin/python aec.py <app.wav> <mic.wav> <out.wav> [delay ms]

Prints the mic level before/after (echo return loss enhancement when the mic holds only echo),
processing cost, and writes the cleaned mic track.
"""

import json
import sys
import time

import numpy as np
import soundfile as sf
from livekit import rtc

app, _ = sf.read(sys.argv[1], dtype="int16")
mic, _ = sf.read(sys.argv[2], dtype="int16")
delay = int(sys.argv[4]) if len(sys.argv) > 4 else 0
n = min(len(app), len(mic)) // 160 * 160
apm = rtc.AudioProcessingModule(echo_cancellation=True, noise_suppression=True,
                                high_pass_filter=True, auto_gain_control=False)
apm.set_stream_delay_ms(delay)
out = np.zeros(n, dtype=np.int16)
t0 = time.perf_counter()
for i in range(0, n, 160):
    far = rtc.AudioFrame(app[i:i + 160].tobytes(), 16000, 1, 160)
    apm.process_reverse_stream(far)
    near = rtc.AudioFrame(mic[i:i + 160].tobytes(), 16000, 1, 160)
    apm.process_stream(near)
    out[i:i + 160] = np.frombuffer(near.data, dtype=np.int16)
wall = time.perf_counter() - t0
sf.write(sys.argv[3], out, 16000, subtype="PCM_16")


def db(x: np.ndarray) -> float:
    x = x.astype(np.float64) / 32768
    return round(10 * np.log10(np.mean(x * x) + 1e-12), 1)


# Skip the first 3 s while AEC3 converges.
s = 16000 * 3
print(json.dumps({"seconds": n / 16000, "wall_s": round(wall, 3), "rtf": round(wall / (n / 16000), 4),
                  "mic_db": db(mic[s:n]), "cleaned_db": db(out[s:]),
                  "reduction_db": round(db(mic[s:n]) - db(out[s:]), 1)}))
