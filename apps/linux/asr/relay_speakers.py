"""Live speaker labels for a call track (relay_asr.py runs it): who said each part of an utterance.

Each finished call-track utterance is split into local turns by pyannote segmentation 3.0 (through
sherpa-onnx's offline diarization over just that utterance), each local voice gets a voice print
(TitaNet-small), and the prints are clustered online across the call, so a voice keeps its label
(2, 3, ...; 1 is the mic's owner) for the whole call. A label is named when its print matches a
known voice: Relay's own voices file (prints learned from calls where the meeting app said who was
talking) or MeetingTranscriber's speakers.json (WeSpeaker ResNet34 prints, compared in that space).
The mic's owner is never a remote voice.

Tuned on two AMI meetings (PLAN.md, Live speakers). CPU only (onnx), so it never competes with
Parakeet on the GPU.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time

import numpy as np

SR = 16000
EMBED_MODEL = "nemo_en_titanet_small.onnx"
# MeetingTranscriber's 256-dim prints are WeSpeaker ResNet34 (its "Isaac" print scores 0.62 against
# this model's print of Isaac's mic and about 0 against everyone else's).
MT_MODEL = "wespeaker_en_voxceleb_resnet34_LM.onnx"
SEGMENT_MODEL = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
# Online clustering: a print this close to a voice is that voice; one this far from every voice,
# from at least NEW_MIN_S of speech, is a new voice; in between it joins the nearest.
SAME = 0.40
NEW_BELOW = 0.35
NEW_MIN_S = 1.5
# Prints shorter than this are too noisy: the turn takes its neighbour's label.
EMBED_MIN_S = 0.5
# Down to this long a print can still pick the nearest voice (never found one).
SHORT_MIN_S = 0.25
# The split of one utterance (pyannote clustering threshold inside the utterance).
LOCAL_THRESHOLD = 0.5
# Naming from known voices: this close to a Relay print (same model), or to a MeetingTranscriber
# print (other implementation of the model, so lower), once the voice has NAME_MIN_S of speech.
KNOWN = 0.65
KNOWN_MT = 0.5
NAME_MIN_S = 6.0
# Audio kept per voice for a MeetingTranscriber print.
KEEP_S = 20.0


def unit(v: np.ndarray) -> np.ndarray:
    return v / (np.linalg.norm(v) + 1e-9)


class Prints:
    """A voice print model and the per-utterance split, loaded once (one owner thread)."""

    def __init__(self, models: str, embed_model: str = EMBED_MODEL, split: bool = True):
        import sherpa_onnx

        self.model = embed_model
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=os.path.join(models, embed_model), num_threads=2)
        )
        self.splitter = None
        if split:
            self.splitter = sherpa_onnx.OfflineSpeakerDiarization(
                sherpa_onnx.OfflineSpeakerDiarizationConfig(
                    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=os.path.join(models, SEGMENT_MODEL)),
                        num_threads=2,
                    ),
                    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=os.path.join(models, embed_model), num_threads=2),
                    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=LOCAL_THRESHOLD),
                    min_duration_on=0.2,
                    min_duration_off=0.3,
                )
            )

    @property
    def dim(self) -> int:
        return int(self.extractor.dim)

    def embed(self, audio: np.ndarray, min_s: float = EMBED_MIN_S) -> np.ndarray | None:
        if len(audio) < min_s * SR:
            return None
        st = self.extractor.create_stream()
        st.accept_waveform(SR, audio)
        st.input_finished()
        if not self.extractor.is_ready(st):
            return None
        return unit(np.array(self.extractor.compute(st), dtype=np.float32))

    def split(self, audio: np.ndarray) -> list[tuple[float, float, int]]:
        """Local turns [(start s, end s, local voice)] of one utterance; one turn when it is short."""
        dur = len(audio) / SR
        if dur < 2.0 or self.splitter is None:
            return [(0.0, dur, 0)]
        try:
            res = self.splitter.process(audio).sort_by_start_time()
        except Exception:  # noqa: BLE001
            return [(0.0, dur, 0)]
        turns = [(float(r.start), float(r.end), int(r.speaker)) for r in res]
        return turns or [(0.0, dur, 0)]


def same_person(a: str, b: str) -> bool:
    """"Isaac" and "Isaac Weber" are one person (first names compared)."""
    fa, fb = a.strip().split(" ")[0].lower(), b.strip().split(" ")[0].lower()
    return fa == fb and fa != ""


class KnownVoices:
    """Named prints. Relay's voices file: {"model", "voices": {name: {"print", "seconds", "updated"}}}
    in EMBED_MODEL's space; MeetingTranscriber's speakers.json: [{name, centroid, embeddings}] whose
    256-dim vectors are compared with MT_MODEL prints."""

    def __init__(self, relay_path: str | None, mt_path: str | None):
        self.relay_path = relay_path
        self.relay: dict = {"model": EMBED_MODEL, "voices": {}}
        if relay_path and os.path.exists(relay_path):
            try:
                data = json.load(open(relay_path))
                if data.get("model") == EMBED_MODEL:
                    self.relay = data
            except Exception:  # noqa: BLE001
                pass
        self.mt: list[tuple[str, np.ndarray]] = []
        if mt_path and os.path.exists(mt_path):
            try:
                for sp in json.load(open(mt_path)):
                    if sp.get("isSynthetic") or not sp.get("name"):
                        continue
                    for v in [sp.get("centroid") or []] + list(sp.get("embeddings") or []):
                        if len(v) == 256:
                            self.mt.append((sp["name"], unit(np.array(v, dtype=np.float32))))
            except Exception:  # noqa: BLE001
                pass

    def match(self, p: np.ndarray, exclude) -> tuple[str | None, float]:
        best, sim = None, -1.0
        for name, v in self.relay.get("voices", {}).items():
            if exclude(name):
                continue
            s = float(np.dot(p, unit(np.array(v["print"], dtype=np.float32))))
            if s > sim:
                best, sim = name, s
        return (best, sim) if sim >= KNOWN else (None, sim)

    def match_mt(self, p: np.ndarray, exclude) -> tuple[str | None, float]:
        best, sim = None, -1.0
        for name, q in self.mt:
            if exclude(name):
                continue
            s = float(np.dot(p, q))
            if s > sim:
                best, sim = name, s
        return (best, sim) if sim >= KNOWN_MT else (None, sim)

    def learn(self, name: str, p: np.ndarray, seconds: float):
        """Adds a platform-named print (the meeting app said who was talking) to Relay's voices."""
        if not self.relay_path or seconds < 20:
            return
        voices = self.relay.setdefault("voices", {})
        v = voices.get(name)
        if v is None:
            new, total = p, seconds
        else:
            had = float(v.get("seconds", 0))
            total = had + seconds
            new = unit(np.array(v["print"], dtype=np.float32) * had + p * seconds)
        voices[name] = {"print": [round(float(x), 5) for x in new], "seconds": round(total, 1), "updated": int(time.time())}
        os.makedirs(os.path.dirname(self.relay_path) or ".", exist_ok=True)
        tmp = self.relay_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.relay, f)
        os.replace(tmp, self.relay_path)


class Voice:
    def __init__(self, label: int, p: np.ndarray, seconds: float):
        self.label = label
        self.sum = p * min(seconds, 10.0)
        self.seconds = seconds
        self.name: str | None = None
        self.tried_mt_at = 0.0
        self.clips: list[np.ndarray] = []

    @property
    def print(self) -> np.ndarray:
        return unit(self.sum)

    def add(self, p: np.ndarray, seconds: float):
        # Long turns weigh more, capped so one monologue does not freeze the print.
        self.sum = self.sum + p * min(seconds, 10.0)
        self.seconds += seconds

    def keep(self, audio: np.ndarray):
        """Keeps the longest clips, up to KEEP_S, for a print in another model's space."""
        self.clips.append(audio)
        self.clips.sort(key=len, reverse=True)
        total, kept = 0, []
        for c in self.clips:
            if total >= KEEP_S * SR:
                break
            kept.append(c)
            total += len(c)
        self.clips = kept


class CallVoices:
    """One call's voices, labelled in order of first appearance (2, 3, ...: 1 is the mic's owner)."""

    def __init__(self, known: KnownVoices | None = None, human: str = "", mt_prints: Prints | None = None):
        self.voices: list[Voice] = []
        self.known = known
        self.human = human
        self.mt_prints = mt_prints

    def assign(self, p: np.ndarray | None, seconds: float, audio: np.ndarray | None = None) -> int | None:
        if p is None:
            return None
        sims = [float(np.dot(p, v.print)) for v in self.voices]
        best = int(np.argmax(sims)) if sims else -1
        top = sims[best] if sims else -1.0
        if best < 0 or (top < NEW_BELOW and seconds >= NEW_MIN_S):
            v = Voice(len(self.voices) + 2, p, seconds)
            self.voices.append(v)
        else:
            v = self.voices[best]
            if top >= SAME:
                v.add(p, seconds)
        if audio is not None and len(audio) >= SR:
            v.keep(audio)
        self.name(v)
        return v.label

    def taken(self, v: Voice):
        names = {o.name for o in self.voices if o is not v and o.name}
        return lambda n: n in names or (self.human != "" and same_person(n, self.human))

    def name(self, v: Voice):
        if self.known is None or v.name or v.seconds < NAME_MIN_S:
            return
        name, _ = self.known.match(v.print, self.taken(v))
        if name is None and self.mt_prints is not None and self.known.mt and v.seconds >= v.tried_mt_at + NAME_MIN_S:
            v.tried_mt_at = v.seconds
            p = self.mt_prints.embed(np.concatenate(v.clips)) if v.clips else None
            if p is not None:
                name, _ = self.known.match_mt(p, self.taken(v))
        if name is not None:
            v.name = name

    def names(self) -> dict[str, str]:
        return {str(v.label): v.name for v in self.voices if v.name}

    def voice(self, label: int) -> Voice | None:
        return next((v for v in self.voices if v.label == label), None)


def label_utterance(prints: Prints, voices: CallVoices, audio: np.ndarray) -> list[dict]:
    """Turns [{start, end, speaker}] (seconds from the utterance start) with call-wide labels."""
    local = prints.split(audio)
    by: dict[int, list[tuple[float, float]]] = {}
    for s, e, k in local:
        by.setdefault(k, []).append((s, e))
    label_of: dict[int, int | None] = {}
    # The local voice with the most speech first: its print is the most reliable.
    for k in sorted(by, key=lambda k: -sum(e - s for s, e in by[k])):
        parts = [audio[int(s * SR) : int(e * SR)] for s, e in by[k]]
        joined = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        # A short local voice ("yeah", "okay") is too short to found a voice but still joins the
        # nearest one (assign never makes a new voice from under NEW_MIN_S).
        label_of[k] = voices.assign(prints.embed(joined, SHORT_MIN_S), len(joined) / SR, joined)
    turns: list[dict] = []
    last = None
    for s, e, k in local:
        lab = label_of.get(k)
        if lab is None:
            lab = last
        if lab is None:
            continue
        last = lab
        if turns and turns[-1]["speaker"] == lab and s - turns[-1]["end"] < 0.5:
            turns[-1]["end"] = round(e, 2)
        else:
            turns.append({"start": round(s, 2), "end": round(e, 2), "speaker": lab})
    # Turns before the first labelled one take its label.
    if turns and local and local[0][0] < turns[0]["start"]:
        turns[0]["start"] = round(local[0][0], 2)
    return turns


class LiveSpeakers:
    """The worker's speaker thread: call-track utterances in, `turns` events out."""

    def __init__(self, models: str, emit, relay_voices: str | None, mt_speakers: str | None):
        self.models = models
        self.emit = emit
        self.relay_voices = relay_voices
        self.mt_speakers = mt_speakers
        self.q: queue.Queue = queue.Queue()
        self.calls: dict[str, CallVoices] = {}
        self.humans: dict[str, str] = {}
        self.prints: Prints | None = None
        self.mt_prints: Prints | None = None
        self.known: KnownVoices | None = None
        threading.Thread(target=self.loop, daemon=True).start()

    def open(self, meeting: str, human: str):
        self.q.put(("open", meeting, human))

    def put(self, meeting: str, line_id: str, start: int, audio: np.ndarray):
        self.q.put(("utt", meeting, line_id, start, audio))

    def learn(self, meeting: str, label: int, name: str):
        self.q.put(("learn", meeting, label, name))

    def close(self, meeting: str, then=None):
        """Forgets the call once everything queued before is labelled, then calls `then`."""
        self.q.put(("close", meeting, then))

    def setup(self):
        if self.prints is None:
            self.prints = Prints(self.models)
            self.known = KnownVoices(self.relay_voices, self.mt_speakers)
            if self.known.mt and os.path.exists(os.path.join(self.models, MT_MODEL)):
                self.mt_prints = Prints(self.models, MT_MODEL, split=False)

    def call(self, meeting: str) -> CallVoices:
        if meeting not in self.calls:
            self.calls[meeting] = CallVoices(self.known, self.humans.get(meeting, ""), self.mt_prints)
        return self.calls[meeting]

    def loop(self):
        while True:
            item = self.q.get()
            try:
                kind = item[0]
                if kind == "open":
                    self.humans[item[1]] = item[2]
                    continue
                if kind == "close":
                    self.calls.pop(item[1], None)
                    self.humans.pop(item[1], None)
                    if item[2] is not None:
                        item[2]()
                    continue
                self.setup()
                if kind == "learn":
                    _, meeting, label, name = item
                    v = self.call(meeting).voice(int(label))
                    if v is not None and self.known is not None:
                        self.known.learn(name, v.print, v.seconds)
                        self.emit({"ev": "log", "message": f"speakers: learned {name}'s voice ({v.seconds:.0f} s)"})
                    continue
                _, meeting, line_id, start, audio = item
                call = self.call(meeting)
                t0 = time.perf_counter()
                turns = label_utterance(self.prints, call, audio)
                self.emit({
                    "ev": "turns",
                    "meeting": meeting,
                    "id": line_id,
                    "turns": [{"start": start + int(t["start"] * SR), "end": start + int(t["end"] * SR), "speaker": t["speaker"]} for t in turns],
                    "names": call.names(),
                    "ms": round((time.perf_counter() - t0) * 1000),
                })
            except Exception as e:  # noqa: BLE001
                self.emit({"ev": "log", "message": f"speakers: {e}"})
