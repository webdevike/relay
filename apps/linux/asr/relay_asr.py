"""relay-asr: the Relay Host's meeting transcription worker (apps/linux/src/meetings/asr.ts runs it).

One process per host, models kept loaded while there is work and dropped after 10 idle minutes.
JSON lines on stdin are commands, JSON lines on stdout are events.

Live (one session per recording):
  {"op":"open","meeting":ID,"human":NAME}   NAME: the mic's owner, never a remote voice's name
  {"op":"audio","meeting":ID,"track":"app"|"mic","at":SAMPLE,"pcm":"<base64 s16le 16 kHz mono>"}
  {"op":"learn","meeting":ID,"label":N,"name":NAME}   the meeting app named voice N: remember it
  {"op":"close","meeting":ID}            flushes the open utterances as finals, then {"ev":"closed"}
  -> {"ev":"line","meeting":ID,"track":T,"id":"mic-3","start":SAMPLE,"end":SAMPLE,"text":"...","final":bool}
     (app finals also carry "words": [[start, end, word], ...] in samples)
  -> {"ev":"turns","meeting":ID,"id":LINE,"turns":[{start,end,speaker:N}],"names":{"N":NAME}}
     after each app final: who spoke when inside it, as call-wide voice labels (2, 3, ...), and
     the labels a known voice print names (relay_speakers.py; RELAY_ASR_MODELS, RELAY_VOICES and
     RELAY_MT_SPEAKERS in the environment)

  The mic runs through WebRTC AEC3 (livekit's AudioProcessingModule) with the app track as the
  far end, so speaker bleed is cancelled before it is heard. Each track is cut into utterances by
  an energy VAD on 30 ms frames (an utterance closes after 0.6 s of quiet or at 15 s); the open
  utterance is decoded every second as a draft and once more as the final when it closes. Measured
  on the Mini (spike/meetings/results): finals 0.65 s after a pause, under 10% of the GPU per track,
  same words as an offline pass.

Jobs (after the call; answered by {"ev":"result","req":R,...} or {"ev":"error","req":R,...}):
  {"op":"aec","req":R,"app":WAV,"mic":WAV,"out":WAV}             the whole mic track, cancelled
  {"op":"transcribe","req":R,"wav":WAV}                          -> segments [{start,end,text}] (s)
  {"op":"diarize","req":R,"wav":WAV,"models":DIR}                -> turns [{start,end,speaker}] (s)

Live decodes always go first; a job's utterances are decoded between them, so a long re-pass never
holds up a call in progress.
"""

import base64
import json
import os
import queue
import sys
import threading
import time

import numpy as np

SR = 16000
FRAME = int(SR * 0.03)
QUIET_S = 0.6
MAX_UTTERANCE_S = 15.0
DRAFT_EVERY_S = 1.0
IDLE_UNLOAD_S = 600
MODEL = os.environ.get("RELAY_ASR_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")

out_lock = threading.Lock()


def emit(obj):
    line = json.dumps(obj, separators=(",", ":"))
    with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg):
    emit({"ev": "log", "message": msg})


def to_float(pcm: np.ndarray) -> np.ndarray:
    return pcm.astype(np.float32) / 32768.0


def read_wav(path: str) -> np.ndarray:
    import soundfile as sf

    data, rate = sf.read(path, dtype="int16", always_2d=True)
    if rate != SR:
        raise ValueError(f"{path}: {rate} Hz, expected {SR}")
    return data[:, 0].copy()


# ---------------------------------------------------------------------------------------------
# The model (owned by the GPU thread only: MLX is used from one thread)
# ---------------------------------------------------------------------------------------------


class Model:
    def __init__(self):
        self.pk = None
        self.last_used = time.monotonic()

    def decode(self, audio: np.ndarray):
        """Sentences [(start s, end s, text)] of one utterance (float32 samples)."""
        return self.decode_words(audio)[0]

    def decode_words(self, audio: np.ndarray):
        """Sentences [(start s, end s, text)] and words [(start s, end s, text)] of one utterance."""
        import mlx.core as mx

        if self.pk is None:
            from parakeet_mlx import from_pretrained

            t0 = time.perf_counter()
            self.pk = from_pretrained(MODEL)
            log(f"loaded {MODEL} in {time.perf_counter() - t0:.1f} s")
        self.last_used = time.monotonic()
        if len(audio) < SR // 10:
            return [], []
        from parakeet_mlx.audio import get_logmel

        mel = get_logmel(mx.array(audio), self.pk.preprocessor_config)
        out, words = [], []
        for r in self.pk.generate(mel):
            for s in r.sentences:
                text = s.text.strip()
                if text:
                    out.append((float(s.start), float(s.end), text))
                for t in s.tokens:
                    # A token starting with a space starts a word; the rest continue it.
                    if t.text.startswith(" ") or not words:
                        if t.text.strip():
                            words.append([float(t.start), float(t.end), t.text.strip()])
                    else:
                        words[-1][1] = float(t.end)
                        words[-1][2] += t.text
        return out, [tuple(w) for w in words]

    def maybe_unload(self):
        if self.pk is not None and time.monotonic() - self.last_used > IDLE_UNLOAD_S:
            import mlx.core as mx

            self.pk = None
            mx.clear_cache()
            log("unloaded the model after 10 idle minutes")


# ---------------------------------------------------------------------------------------------
# Energy VAD and utterance windows
# ---------------------------------------------------------------------------------------------


def frame_energy(audio: np.ndarray) -> np.ndarray:
    n = len(audio) // FRAME
    frames = audio[: n * FRAME].reshape(n, FRAME)
    return np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)


def utterances(audio: np.ndarray):
    """[(start sample, end sample)] of a whole track, cut like the live view cuts it."""
    energy = frame_energy(audio)
    if len(energy) == 0:
        return []
    floor = float(np.percentile(energy, 20))
    voiced = energy > max(floor * 3, 10 ** (-45 / 20))
    out, start, quiet = [], None, 0
    for k, v in enumerate(voiced):
        if v:
            if start is None:
                start = k * FRAME
            quiet = 0
        elif start is not None:
            quiet += 1
        end = (k + 1) * FRAME
        if start is not None and (quiet * FRAME / SR >= QUIET_S or end - start >= MAX_UTTERANCE_S * SR):
            out.append((start, end))
            start, quiet = None, 0
    if start is not None:
        out.append((start, len(voiced) * FRAME))
    return out


class TrackState:
    """One live track: its samples from `origin` on, the open utterance. Line ids are the track and
    the utterance's first sample, so a session resumed after a host restart never reuses one."""

    def __init__(self, name: str, origin: int):
        self.name = name
        self.audio = np.zeros(0, dtype=np.float32)
        # Index of audio[0] in the recording (old audio is dropped once no utterance needs it).
        self.base = origin
        self.origin = origin
        self.scanned = 0  # frames from `origin` looked at by the VAD
        self.energies: list[float] = []
        self.start = None  # sample where the open utterance began
        self.quiet = 0
        self.next_draft = 0  # sample at which the next draft is due
        self.decoding = False
        self.floor_value = 0.0

    @property
    def end(self):
        return self.base + len(self.audio)

    def append(self, pcm: np.ndarray):
        self.audio = np.concatenate([self.audio, to_float(pcm)])

    def floor(self):
        recent = self.energies[-2000:]
        return float(np.percentile(recent, 20)) if recent else 0.0

    def slice(self, start, end):
        return self.audio[start - self.base : end - self.base].copy()

    def trim(self):
        keep_from = self.start if self.start is not None else self.origin + self.scanned * FRAME
        drop = max(0, keep_from - self.base - SR)  # keep a second of context
        if drop > SR * 30:
            self.audio = self.audio[drop:]
            self.base += drop

    def line_id(self):
        return f"{self.name}-{self.start}"


class Session:
    def __init__(self, meeting: str, app_at: int, mic_at: int):
        self.meeting = meeting
        self.tracks = {"app": TrackState("app", app_at), "mic": TrackState("mic", mic_at)}
        self.lock = threading.Lock()
        self.raw_mic = np.zeros(0, dtype=np.int16)
        self.mic_base = mic_at
        self.app_ref = np.zeros(0, dtype=np.int16)
        self.app_ref_base = app_at
        self.apm = None
        try:
            from livekit import rtc

            self.apm = rtc.AudioProcessingModule(
                echo_cancellation=True, noise_suppression=True, high_pass_filter=True, auto_gain_control=False
            )
            self.rtc = rtc
        except Exception as e:  # noqa: BLE001
            log(f"aec off for {meeting}: {e}")

    def add(self, track: str, at: int, pcm: np.ndarray):
        """Takes contiguous audio; the mic goes through AEC once the app audio of the same time is in."""
        with self.lock:
            if track == "app":
                self.tracks["app"].append(pcm)
                self.app_ref = np.concatenate([self.app_ref, pcm])
            else:
                self.raw_mic = np.concatenate([self.raw_mic, pcm])
            self.cancel_echo(flush=False)

    def cancel_echo(self, flush: bool):
        mic = self.tracks["mic"]
        while len(self.raw_mic) >= 160:
            t = self.mic_base
            ref_off = t - self.app_ref_base
            have_ref = len(self.app_ref) - ref_off >= 160
            # The app track lags more than a second behind (or stopped): cancel against silence.
            if not have_ref and not flush and self.app_ref_base + len(self.app_ref) + SR > t + len(self.raw_mic):
                break
            near_pcm = self.raw_mic[:160]
            if self.apm is not None:
                far_pcm = self.app_ref[ref_off : ref_off + 160] if have_ref and ref_off >= 0 else np.zeros(160, dtype=np.int16)
                far = self.rtc.AudioFrame(far_pcm.tobytes(), SR, 1, 160)
                self.apm.process_reverse_stream(far)
                near = self.rtc.AudioFrame(near_pcm.tobytes(), SR, 1, 160)
                self.apm.process_stream(near)
                cleaned = np.frombuffer(near.data, dtype=np.int16).copy()
            else:
                cleaned = near_pcm
            mic.append(cleaned)
            self.raw_mic = self.raw_mic[160:]
            self.mic_base += 160
        # Far-end audio older than the mic position is not needed again.
        drop = self.mic_base - self.app_ref_base - SR
        if drop > SR * 10:
            self.app_ref = self.app_ref[drop:]
            self.app_ref_base += drop


# ---------------------------------------------------------------------------------------------
# The GPU thread: live decodes first, job utterances in between
# ---------------------------------------------------------------------------------------------

model = Model()
sessions: dict[str, Session] = {}
sessions_lock = threading.Lock()
live_work: "queue.Queue" = queue.Queue()
jobs: "queue.Queue" = queue.Queue()
# Live speaker labels on the call track (relay_speakers.py); None when its models are missing.
speakers = None


def start_speakers():
    global speakers
    import relay_speakers as rsp

    models = os.environ.get("RELAY_ASR_MODELS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "models"))
    need = [rsp.EMBED_MODEL, rsp.SEGMENT_MODEL]
    missing = [m for m in need if not os.path.exists(os.path.join(models, m))]
    if missing:
        log(f"live speaker labels off: {', '.join(missing)} not in {models} (run setup.sh)")
        return
    speakers = rsp.LiveSpeakers(models, emit, os.environ.get("RELAY_VOICES") or None, os.environ.get("RELAY_MT_SPEAKERS") or None)


def scan(session: Session, track: TrackState, flush: bool):
    """Runs the VAD over new frames; queues drafts and finals. Called with session.lock held."""
    first = track.origin + track.scanned * FRAME
    n = (track.end - first) // FRAME
    if n > 0:
        seg = track.slice(first, first + n * FRAME).reshape(n, FRAME)
        energies = np.sqrt(np.mean(seg * seg, axis=1) + 1e-12)
    else:
        energies = np.zeros(0)
    for e in energies:
        # The noise floor moves slowly; once a second is often enough.
        if track.scanned % 33 == 0:
            track.floor_value = track.floor()
        track.energies.append(float(e))
        if len(track.energies) > 4000:
            del track.energies[:2000]
        voiced = e > max(track.floor_value * 3, 10 ** (-45 / 20))
        f0 = track.origin + track.scanned * FRAME
        track.scanned += 1
        end = f0 + FRAME
        if voiced:
            if track.start is None:
                track.start = f0
                track.next_draft = f0 + int(DRAFT_EVERY_S * SR)
            track.quiet = 0
        elif track.start is not None:
            track.quiet += 1
        if track.start is not None and (track.quiet * FRAME / SR >= QUIET_S or end - track.start >= MAX_UTTERANCE_S * SR):
            live_work.put(("final", session.meeting, track.name, track.line_id(), track.start, end, track.slice(track.start, end)))
            track.start, track.quiet = None, 0
        elif track.start is not None and end >= track.next_draft:
            track.next_draft = end + int(DRAFT_EVERY_S * SR)
            if not track.decoding:
                track.decoding = True
                live_work.put(("draft", session.meeting, track.name, track.line_id(), track.start, end, track.slice(track.start, end)))
    if flush and track.start is not None:
        live_work.put(("final", session.meeting, track.name, track.line_id(), track.start, track.end, track.slice(track.start, track.end)))
        track.start = None
    track.trim()


def run_live(item):
    kind, meeting, track_name, line_id, start, end, audio = item
    if kind == "closed":
        # After the speaker thread has labelled everything queued before it.
        if speakers is not None:
            speakers.close(meeting, lambda: emit({"ev": "closed", "meeting": meeting}))
        else:
            emit({"ev": "closed", "meeting": meeting})
        return
    sents, words = model.decode_words(audio)
    text = " ".join(s[2] for s in sents).strip()
    with sessions_lock:
        s = sessions.get(meeting)
    if kind == "draft" and s is not None:
        s.tracks[track_name].decoding = False
        # A final for this line may already be queued; a stale draft after it is dropped by the host (final wins).
    if kind == "final" and not text:
        emit({"ev": "line", "meeting": meeting, "track": track_name, "id": line_id, "start": start, "end": end, "text": "", "final": True})
        return
    if text:
        line = {"ev": "line", "meeting": meeting, "track": track_name, "id": line_id, "start": start, "end": end, "text": text, "final": kind == "final"}
        if kind == "final" and track_name == "app":
            # Word times (samples) so the host can split a line where the speaker changes.
            line["words"] = [[start + int(w[0] * SR), start + int(w[1] * SR), w[2]] for w in words]
        emit(line)
        if kind == "final" and track_name == "app" and speakers is not None:
            speakers.put(meeting, line_id, start, audio)


class TranscribeJob:
    """A whole track, decoded utterance by utterance so live work can cut in."""

    def __init__(self, req, wav):
        self.req = req
        self.audio = to_float(read_wav(wav))
        self.parts = utterances(self.audio)
        self.i = 0
        self.segments = []

    def step(self) -> bool:
        if self.i >= len(self.parts):
            emit({"ev": "result", "req": self.req, "segments": self.segments})
            return False
        a, b = self.parts[self.i]
        self.i += 1
        for s0, s1, text in model.decode(self.audio[a:b]):
            self.segments.append({"start": round(a / SR + s0, 2), "end": round(a / SR + s1, 2), "text": text})
        return True


def gpu_loop():
    current = None
    while True:
        try:
            item = live_work.get(timeout=0.05 if current is not None else 1.0)
            try:
                run_live(item)
            except Exception as e:  # noqa: BLE001
                emit({"ev": "error", "meeting": item[1], "message": f"decode: {e}"})
            continue
        except queue.Empty:
            pass
        if current is None:
            try:
                current = jobs.get_nowait()
            except queue.Empty:
                model.maybe_unload()
                continue
        try:
            if not current.step():
                current = None
        except Exception as e:  # noqa: BLE001
            emit({"ev": "error", "req": current.req, "message": str(e)})
            current = None


# ---------------------------------------------------------------------------------------------
# CPU jobs (own threads): AEC over a whole call, diarization
# ---------------------------------------------------------------------------------------------


def aec_job(req, app_path, mic_path, out_path):
    import soundfile as sf
    from livekit import rtc

    app = read_wav(app_path)
    mic = read_wav(mic_path)
    n = len(mic) // 160 * 160
    if len(app) < n:
        app = np.concatenate([app, np.zeros(n - len(app), dtype=np.int16)])
    apm = rtc.AudioProcessingModule(echo_cancellation=True, noise_suppression=True, high_pass_filter=True, auto_gain_control=False)
    out = np.zeros(n, dtype=np.int16)
    t0 = time.perf_counter()
    for i in range(0, n, 160):
        apm.process_reverse_stream(rtc.AudioFrame(app[i : i + 160].tobytes(), SR, 1, 160))
        near = rtc.AudioFrame(mic[i : i + 160].tobytes(), SR, 1, 160)
        apm.process_stream(near)
        out[i : i + 160] = np.frombuffer(near.data, dtype=np.int16)
    sf.write(out_path, out, SR, subtype="PCM_16")

    def db(x):
        x = x.astype(np.float64) / 32768
        return round(10 * np.log10(np.mean(x * x) + 1e-12), 1)

    s = min(SR * 3, n)
    emit({"ev": "result", "req": req, "seconds": n / SR, "wall": round(time.perf_counter() - t0, 2),
          "micDb": db(mic[s:n]), "cleanedDb": db(out[s:])})


def diarize_job(req, wav, models, threshold):
    import sherpa_onnx

    audio = to_float(read_wav(wav))
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=f"{models}/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"),
            num_threads=4),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=f"{models}/nemo_en_titanet_small.onnx", num_threads=4),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    t0 = time.perf_counter()
    result = sherpa_onnx.OfflineSpeakerDiarization(config).process(audio).sort_by_start_time()
    turns = [{"start": round(r.start, 2), "end": round(r.end, 2), "speaker": int(r.speaker)} for r in result]
    turns = merge_speakers(turns, audio, models)
    emit({"ev": "result", "req": req, "turns": turns, "wall": round(time.perf_counter() - t0, 1)})


def merge_speakers(turns, audio, models, same=0.55, min_talk_s=8.0):
    """The clustering over-splits one voice into several: speakers whose voice prints are close
    (cosine >= `same`) are merged, and speakers with under `min_talk_s` of talk join the nearest."""
    import sherpa_onnx

    if not turns:
        return turns
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=f"{models}/nemo_en_titanet_small.onnx", num_threads=4))
    talk: dict[int, float] = {}
    by: dict[int, list] = {}
    for t in turns:
        talk[t["speaker"]] = talk.get(t["speaker"], 0.0) + t["end"] - t["start"]
        by.setdefault(t["speaker"], []).append(t)

    def embed(spk):
        vecs = []
        # The longest few turns of the speaker, at most 8, give a stable print cheaply.
        for t in sorted(by[spk], key=lambda t: t["start"] - t["end"])[:8]:
            seg = audio[int(t["start"] * SR) : int(t["end"] * SR)]
            if len(seg) < SR // 2:
                continue
            st = ex.create_stream()
            st.accept_waveform(SR, seg)
            st.input_finished()
            if ex.is_ready(st):
                vecs.append(np.array(ex.compute(st)))
        if not vecs:
            return None
        v = np.mean(vecs, axis=0)
        return v / (np.linalg.norm(v) + 1e-9)

    prints = {s: embed(s) for s in by}
    parent = {s: s for s in by}

    def root(s):
        while parent[s] != s:
            s = parent[s]
        return s

    order = sorted(by, key=lambda s: -talk[s])
    for i, a in enumerate(order):
        for b in order[i + 1 :]:
            pa, pb = prints[root(a)], prints[b]
            if pa is None or pb is None or root(b) != b:
                continue
            if float(np.dot(pa, pb)) >= same:
                parent[b] = root(a)
    groups: dict[int, float] = {}
    for s in by:
        groups[root(s)] = groups.get(root(s), 0.0) + talk[s]
    big = [g for g in groups if groups[g] >= min_talk_s] or [max(groups, key=groups.get)]
    for s in by:
        g = root(s)
        if g in big:
            continue
        p = prints[s]
        best = max(big, key=lambda b: float(np.dot(p, prints[b])) if p is not None and prints[b] is not None else -1)
        parent[s] = best
    # Labels by order of first appearance: S1 speaks first.
    labels: dict[int, int] = {}
    out = []
    for t in turns:
        g = root(t["speaker"])
        if g not in labels:
            labels[g] = len(labels) + 1
        out.append({"start": t["start"], "end": t["end"], "speaker": labels[g]})
    return out


def cpu_job(fn, req, *args):
    def run():
        try:
            fn(req, *args)
        except Exception as e:  # noqa: BLE001
            emit({"ev": "error", "req": req, "message": str(e)})

    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------------------------------------
# stdin
# ---------------------------------------------------------------------------------------------


def handle(msg):
    op = msg.get("op")
    if op == "open":
        # `app`/`mic`: the sample each track's audio resumes at (0 for a new recording).
        with sessions_lock:
            if msg["meeting"] not in sessions:
                sessions[msg["meeting"]] = Session(msg["meeting"], int(msg.get("app", 0)), int(msg.get("mic", 0)))
        if speakers is not None:
            speakers.open(msg["meeting"], str(msg.get("human", "")))
    elif op == "learn":
        # The meeting app named this voice for most of its talk: Relay's voices file gets its print.
        if speakers is not None:
            speakers.learn(msg["meeting"], int(msg["label"]), str(msg["name"]))
    elif op == "audio":
        with sessions_lock:
            s = sessions.get(msg["meeting"])
        if s is None:
            return
        pcm = np.frombuffer(base64.b64decode(msg["pcm"]), dtype=np.int16)
        s.add(msg["track"], int(msg["at"]), pcm)
        with s.lock:
            scan(s, s.tracks["app"], flush=False)
            scan(s, s.tracks["mic"], flush=False)
    elif op == "close":
        with sessions_lock:
            s = sessions.pop(msg["meeting"], None)
        if s is not None:
            with s.lock:
                s.cancel_echo(flush=True)
                scan(s, s.tracks["app"], flush=True)
                scan(s, s.tracks["mic"], flush=True)
        live_work.put(("closed", msg["meeting"], None, None, None, None, None))
    elif op == "transcribe":
        try:
            jobs.put(TranscribeJob(msg["req"], msg["wav"]))
        except Exception as e:  # noqa: BLE001
            emit({"ev": "error", "req": msg["req"], "message": str(e)})
    elif op == "aec":
        cpu_job(aec_job, msg["req"], msg["app"], msg["mic"], msg["out"])
    elif op == "diarize":
        cpu_job(diarize_job, msg["req"], msg["wav"], msg["models"], float(msg.get("threshold", 0.7)))
    else:
        emit({"ev": "error", "message": f"unknown op {op}"})


def main():
    threading.Thread(target=gpu_loop, daemon=True).start()
    start_speakers()
    emit({"ev": "ready", "model": MODEL})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except Exception as e:  # noqa: BLE001
            emit({"ev": "error", "message": f"bad command: {e}"})


if __name__ == "__main__":
    main()
