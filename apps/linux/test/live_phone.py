#!/usr/bin/env python3
"""The phone's side of a GPT-Live call, for test/live-smoke.ts: a WebRTC peer with a microphone
track and the `oai-events` data channel, exactly what the iPhone builds, driven over JSON lines.

stdout (one JSON object a line):
  {"t":"offer","sdp":...}                    the complete (non-trickle) SDP offer
  {"t":"event","at":ms,"event":{...}}        every data-channel event except audio
  {"t":"audio","at":ms,"on":true|false}      remote audio crossed the speech threshold
  {"t":"played","at":ms,"name":...}          a WAV finished playing into the microphone
  {"t":"closed","at":ms}
stdin:
  {"t":"answer","sdp":...}                   OpenAI's answer (via the host)
  {"t":"play","wav":path,"name":...}         speak this file into the call (48 kHz mono s16)
  {"t":"close"}                              send session.close on the data channel, then exit
`at` is wall-clock ms since the epoch. Received audio is written to --out as 48 kHz mono WAV.
Needs: aiortc, numpy (uv venv; see live-smoke.ts).
"""

import argparse
import asyncio
import fractions
import json
import sys
import time
import wave

import numpy as np
from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame

RATE = 48_000
FRAME = 960  # 20 ms
SPEECH_DB = -40.0


def now() -> int:
    return int(time.time() * 1000)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Microphone(MediaStreamTrack):
    """Silence, or a queued WAV, in real-time 20 ms frames."""

    kind = "audio"

    def __init__(self) -> None:
        super().__init__()
        self.queue: list[tuple[np.ndarray, str]] = []
        self.current: np.ndarray | None = None
        self.name = ""
        self.offset = 0
        self.pts = 0
        self.started: float | None = None

    def play(self, samples: np.ndarray, name: str) -> None:
        self.queue.append((samples, name))

    async def recv(self) -> AudioFrame:
        if self.started is None:
            self.started = time.time()
        due = self.started + self.pts / RATE
        delay = due - time.time()
        if delay > 0:
            await asyncio.sleep(delay)
        if self.current is None and self.queue:
            self.current, self.name = self.queue.pop(0)
            self.offset = 0
        chunk = np.zeros(FRAME, dtype=np.int16)
        if self.current is not None:
            piece = self.current[self.offset : self.offset + FRAME]
            chunk[: len(piece)] = piece
            self.offset += FRAME
            if self.offset >= len(self.current):
                emit({"t": "played", "at": now(), "name": self.name})
                self.current = None
        frame = AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
        frame.sample_rate = RATE
        frame.pts = self.pts
        frame.time_base = fractions.Fraction(1, RATE)
        self.pts += FRAME
        return frame


def read_wav(path: str) -> np.ndarray:
    with wave.open(path, "rb") as source:
        if source.getframerate() != RATE or source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise SystemExit(f"{path}: need 48 kHz mono s16")
        return np.frombuffer(source.readframes(source.getnframes()), dtype=np.int16)


async def record(track: MediaStreamTrack, out: wave.Wave_write) -> None:
    speaking = False
    quiet = 0
    while True:
        try:
            frame = await track.recv()
        except Exception:
            return
        pcm = frame.to_ndarray()
        mono = pcm.reshape(-1, len(frame.layout.channels)).mean(axis=1).astype(np.int16) if pcm.ndim > 1 or len(frame.layout.channels) > 1 else pcm.astype(np.int16)
        if frame.sample_rate != RATE:
            continue
        out.writeframes(mono.tobytes())
        level = 10 * np.log10(np.mean((mono.astype(np.float64) / 32768.0) ** 2) + 1e-12)
        if level > SPEECH_DB:
            quiet = 0
            if not speaking:
                speaking = True
                emit({"t": "audio", "at": now(), "on": True})
        elif speaking:
            quiet += 1
            if quiet >= 25:  # 500 ms of quiet ends a stretch of speech
                speaking = False
                emit({"t": "audio", "at": now(), "on": False})


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    pc = RTCPeerConnection()
    mic = Microphone()
    pc.addTrack(mic)
    channel = pc.createDataChannel("oai-events")
    closed = asyncio.Event()
    out = wave.open(args.out, "wb")
    out.setnchannels(1)
    out.setsampwidth(2)
    out.setframerate(RATE)

    @channel.on("message")
    def on_message(data: str) -> None:
        event = json.loads(data)
        emit({"t": "event", "at": now(), "event": event})
        if event.get("type") == "session.closed":
            closed.set()

    @pc.on("track")
    def on_track(track: MediaStreamTrack) -> None:
        if track.kind == "audio":
            asyncio.ensure_future(record(track, out))

    await pc.setLocalDescription(await pc.createOffer())
    emit({"t": "offer", "sdp": pc.localDescription.sdp})

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while not closed.is_set():
        line = await reader.readline()
        if not line:
            break
        command = json.loads(line)
        if command["t"] == "answer":
            await pc.setRemoteDescription(RTCSessionDescription(sdp=command["sdp"], type="answer"))
        elif command["t"] == "play":
            mic.play(read_wav(command["wav"]), command.get("name", command["wav"]))
        elif command["t"] == "close":
            if channel.readyState == "open":
                channel.send(json.dumps({"type": "session.close", "event_id": "phone-close"}))
                try:
                    await asyncio.wait_for(closed.wait(), 5)
                except asyncio.TimeoutError:
                    pass
            break
    await pc.close()
    out.close()
    emit({"t": "closed", "at": now()})


asyncio.run(main())
