"""ASR spike: realtime factor and agreement with MeetingTranscriber's own transcript.

Run with the spike venv (parakeet-mlx, mlx-whisper, jiwer):
  ~/.cache/relay-meetings-spike/.venv/bin/python bench.py <recordings stem> <protocol .txt> <start s> <end s>

Takes the stem's _app.wav (remote side) and _mic.wav (Isaac) tracks, cuts [start, end), and runs:
  - parakeet-tdt-0.6b-v3 offline on each track
  - parakeet-tdt-0.6b-v3 streaming in 0.5 s and 1.0 s chunks (what the live view would run)
  - whisper-large-v3-turbo (mlx-whisper) offline on each track
Reference text is MeetingTranscriber's .txt lines whose start falls in the window, split by
speaker: "Isaac" lines for the mic track, everything else for the app track. That transcript is
Parakeet v3 itself (FluidAudio CoreML), so WER here is agreement with the shipping engine, not
accuracy against a human transcript.
"""

import json
import re
import subprocess
import sys
import time

import jiwer
import mlx.core as mx
import numpy as np

SR = 16000
FILLERS = {"um", "uh", "mm", "hmm", "mhm", "ah", "er", "oh"}


def load(path: str, start: float, end: float) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(start), "-to", str(end), "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def norm(text: str) -> str:
    text = text.lower().replace("-", " ")
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return " ".join(w for w in text.split() if w not in FILLERS)


def reference(txt: str, start: float, end: float) -> dict[str, str]:
    out = {"mic": [], "app": []}
    for line in open(txt, encoding="utf-8"):
        m = re.match(r"\[(\d+):(\d+)\] ([^:]+): (.*)", line.strip())
        if not m:
            continue
        t = int(m[1]) * 60 + int(m[2])
        if start <= t < end:
            out["mic" if m[3] == "Isaac" else "app"].append(m[4])
    return {k: " ".join(v) for k, v in out.items()}


def wer(ref: str, hyp: str) -> float | None:
    r, h = norm(ref), norm(hyp)
    if not r:
        return None
    return round(jiwer.wer(r, h), 3)


def timed(fn):
    mx.clear_cache()
    mx.reset_peak_memory()
    t0 = time.perf_counter()
    out = fn()
    return out, time.perf_counter() - t0, mx.get_peak_memory() / 2**30


def main() -> None:
    stem, txt, start, end = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
    dur = end - start
    tracks = {k: load(f"{stem}_{k}.wav", start, end) for k in ("app", "mic")}
    ref = reference(txt, start, end)
    rows = []

    from parakeet_mlx import from_pretrained

    t0 = time.perf_counter()
    pk = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
    rows.append({"step": "parakeet load", "s": round(time.perf_counter() - t0, 2)})
    # Warm the kernels once so the first track does not pay compilation.
    with pk.transcribe_stream(context_size=(256, 256)) as warm:
        warm.add_audio(mx.array(tracks["app"][: SR * 2]))

    import tempfile

    import soundfile

    for name, audio in tracks.items():
        # Offline: parakeet's transcribe takes a path, so write the cut once.
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            soundfile.write(f.name, audio, SR, subtype="PCM_16")
            res, wall, peak = timed(lambda: pk.transcribe(f.name))
        rows.append({"engine": "parakeet-v3 offline", "track": name, "wall_s": round(wall, 2),
                     "rtf": round(wall / dur, 4), "peak_gb": round(peak, 2),
                     "wer_vs_mt": wer(ref[name], res.text), "text": res.text})

        for chunk_s in (0.5, 1.0):
            n = int(SR * chunk_s)
            lat = []
            first_final_at = None

            def run():
                nonlocal first_final_at
                with pk.transcribe_stream(context_size=(256, 256)) as s:
                    for i in range(0, len(audio), n):
                        c0 = time.perf_counter()
                        s.add_audio(mx.array(audio[i : i + n]))
                        lat.append(time.perf_counter() - c0)
                        if first_final_at is None and s.finalized_tokens:
                            first_final_at = (i + n) / SR
                    return s.result

            res, wall, peak = timed(run)
            rows.append({"engine": f"parakeet-v3 stream {chunk_s}s", "track": name,
                         "wall_s": round(wall, 2), "rtf": round(wall / dur, 4),
                         "chunk_ms_p50": round(1000 * float(np.median(lat)), 1),
                         "chunk_ms_p95": round(1000 * float(np.percentile(lat, 95)), 1),
                         "chunk_ms_max": round(1000 * max(lat), 1),
                         "first_final_audio_s": first_final_at, "peak_gb": round(peak, 2),
                         "wer_vs_mt": wer(ref[name], res.text), "text": res.text})

    del pk
    mx.clear_cache()

    import mlx_whisper

    repo = "mlx-community/whisper-large-v3-turbo"
    mlx_whisper.transcribe(tracks["app"][: SR * 2], path_or_hf_repo=repo, language="en")
    for name, audio in tracks.items():
        res, wall, peak = timed(lambda: mlx_whisper.transcribe(
            audio, path_or_hf_repo=repo, language="en", condition_on_previous_text=False))
        rows.append({"engine": "whisper-large-v3-turbo offline", "track": name,
                     "wall_s": round(wall, 2), "rtf": round(wall / dur, 4),
                     "peak_gb": round(peak, 2), "wer_vs_mt": wer(ref[name], res["text"]),
                     "text": res["text"].strip()})

    print(json.dumps({"window": [start, end], "reference": ref, "rows": rows}, indent=1))


if __name__ == "__main__":
    main()
