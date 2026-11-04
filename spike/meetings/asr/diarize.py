"""Diarization cost on the remote (app) track: sherpa-onnx (pyannote segmentation 3.0 + NeMo
TitaNet-small embeddings, CPU), the open-source stack closest to what MeetingTranscriber's
FluidAudio diarizer does on the ANE.

  ~/.cache/relay-meetings-spike/.venv/bin/python diarize.py <app.wav> <models dir> [threads] [start] [end]

Prints wall time, realtime factor, the speaker count it found and the turn count.
"""

import json
import subprocess
import sys
import time

import numpy as np
import sherpa_onnx

wav, models = sys.argv[1], sys.argv[2]
threads = int(sys.argv[3]) if len(sys.argv) > 3 else 4
start = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0
end = float(sys.argv[5]) if len(sys.argv) > 5 else None

cmd = ["ffmpeg", "-v", "error", "-ss", str(start)] + (["-to", str(end)] if end else []) + [
    "-i", wav, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"]
audio = np.frombuffer(subprocess.run(cmd, check=True, capture_output=True).stdout, dtype=np.int16)
audio = audio.astype(np.float32) / 32768.0
dur = len(audio) / 16000

config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
            model=f"{models}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"),
        num_threads=threads),
    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=f"{models}/nemo_en_titanet_small.onnx", num_threads=threads),
    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.7),
    min_duration_on=0.3,
    min_duration_off=0.5,
)
sd = sherpa_onnx.OfflineSpeakerDiarization(config)
t0 = time.perf_counter()
result = sd.process(audio).sort_by_start_time()
wall = time.perf_counter() - t0
speakers = sorted({r.speaker for r in result})
talk = {s: round(sum(r.end - r.start for r in result if r.speaker == s), 1) for s in speakers}
print(json.dumps({"audio_s": round(dur, 1), "wall_s": round(wall, 2), "rtf": round(wall / dur, 4),
                  "threads": threads, "speakers": len(speakers), "turns": len(result),
                  "talk_s_by_speaker": talk}))
