"""Live transcription strategies for one track, simulated in real time order on a recording.

  ~/.cache/relay-meetings-spike/.venv/bin/python bench_live.py <stem> <protocol .txt> <start> <end>

1. StreamingParakeet (parakeet-mlx's cache-aware streaming) with small right contexts. Its default
   (256, 256) holds tokens back 256 encoder frames = 20.5 s and re-encodes that much per chunk.
2. Utterance windows: an energy VAD closes an utterance after 0.6 s of quiet (or at 15 s); every
   1 s the open utterance is re-decoded offline as the draft, and a closed one is decoded once as
   the final. This is the shape MeetingTranscriber's live captions have (hypothesis + finals).
Reports compute per update, total compute as a share of audio time, how long after the words
were spoken they became final, and agreement with MeetingTranscriber's transcript.
"""

import json
import sys
import time

import mlx.core as mx
import numpy as np

from bench import SR, load, reference, wer

stem, txt, start, end = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
dur = end - start
ref = reference(txt, start, end)

from parakeet_mlx import from_pretrained
from parakeet_mlx.audio import get_logmel

pk = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
with pk.transcribe_stream(context_size=(256, 8)) as w:
    w.add_audio(mx.array(np.zeros(SR, dtype=np.float32)))


def decode(audio: np.ndarray) -> str:
    mel = get_logmel(mx.array(audio), pk.preprocessor_config)
    return " ".join(r.text for r in pk.generate(mel)).strip()


decode(np.zeros(SR, dtype=np.float32))
rows = []
for name in ("app", "mic"):
    audio = load(f"{stem}_{name}.wav", start, end)

    for ctx in ((256, 8), (128, 4)):
        lat = []
        first = None
        with pk.transcribe_stream(context_size=ctx) as s:
            for i in range(0, len(audio), SR):
                t0 = time.perf_counter()
                s.add_audio(mx.array(audio[i : i + SR]))
                lat.append(time.perf_counter() - t0)
                if first is None and s.finalized_tokens:
                    first = (i + SR) / SR
            text = s.result.text
        rows.append({"track": name, "strategy": f"stream ctx={ctx} 1s", "compute_share": round(sum(lat) / dur, 3),
                     "update_ms_p50": round(1000 * float(np.median(lat))), "update_ms_max": round(1000 * max(lat)),
                     "first_final_audio_s": first, "final_lag_s": round(ctx[1] * 0.08, 2),
                     "wer_vs_mt": wer(ref[name], text)})

    # Utterance windows with an energy VAD on 30 ms frames.
    frame = int(SR * 0.03)
    energy = np.array([np.sqrt(np.mean(audio[i : i + frame] ** 2) + 1e-12) for i in range(0, len(audio), frame)])
    floor = np.percentile(energy, 20)
    voiced = energy > max(floor * 3, 10 ** (-45 / 20))
    finals, lat, lags = [], [], []
    seg_start = None
    quiet = 0
    next_draft = 1.0
    for k, v in enumerate(voiced):
        now = (k + 1) * frame / SR
        if v:
            if seg_start is None:
                seg_start = k * frame
            quiet = 0
        elif seg_start is not None:
            quiet += 1
        close = seg_start is not None and (quiet * 0.03 >= 0.6 or (k + 1) * frame - seg_start >= 15 * SR)
        if close:
            t0 = time.perf_counter()
            finals.append(decode(audio[seg_start : (k + 1) * frame]))
            lat.append(time.perf_counter() - t0)
            lags.append(quiet * 0.03 + lat[-1])
            seg_start, quiet = None, 0
        elif seg_start is not None and now >= next_draft:
            t0 = time.perf_counter()
            decode(audio[seg_start : (k + 1) * frame])
            lat.append(time.perf_counter() - t0)
        if now >= next_draft:
            next_draft += 1.0
    if seg_start is not None:
        finals.append(decode(audio[seg_start:]))
    text = " ".join(finals)
    rows.append({"track": name, "strategy": "utterance windows (VAD 0.6 s, 15 s cap, 1 s drafts)",
                 "compute_share": round(sum(lat) / dur, 3), "update_ms_p50": round(1000 * float(np.median(lat))),
                 "update_ms_max": round(1000 * max(lat)), "utterances": len(finals),
                 "final_lag_s_p50": round(float(np.median(lags)), 2), "wer_vs_mt": wer(ref[name], text),
                 "text": text})

print(json.dumps({"window": [start, end], "rows": rows}, indent=1))
