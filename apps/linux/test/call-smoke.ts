#!/usr/bin/env bun
// End-to-end smoke of a call against a running host and a real assistant, no phone involved:
// pairs itself as a throwaway device (written straight into this machine's device store, forgotten
// again at the end), calls the agent, streams a WAV as the microphone in real time, records the
// reply audio, and prints a JSON report with the latencies that matter on a call.
//
//   bun test/call-smoke.ts --agent astra --wav question.wav --out reply.wav [--barge barge.wav]
//       [--host ws://127.0.0.1:7817/relay] [--timeout 120]
//
// "Speech end" is the last 20 ms window of the WAV louder than -45 dBFS, at the moment its frame
// was sent; the first audio after it is the filler or the reply, whichever came first. With
// `--barge`, that WAV is streamed as soon as reply audio starts, to show the host flushing.

import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CALL_INPUT_RATE, CALL_OUTPUT_RATE, encode, parseServerMessage, type AssistantMessage, type CallState, type ClientMessage, type ServerMessage } from "@relay/protocol";
import { FileDeviceStore } from "../src/device-store";

const FRAME_MS = 100;
const FRAME_BYTES = (CALL_INPUT_RATE / 1000) * FRAME_MS * 2;

/** `path` as PCM16 LE mono at CALL_INPUT_RATE, through ffmpeg. */
function pcmOf(path: string): Uint8Array {
  const result = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", String(CALL_INPUT_RATE), "-"]);
  if (result.exitCode !== 0) throw new Error(`ffmpeg: ${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}

/** Byte offset where speech ends: the end of the last 20 ms window above -45 dBFS. */
function speechEnd(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const window = (CALL_INPUT_RATE / 50) * 2;
  let end = 0;
  for (let at = 0; at + window <= pcm.byteLength; at += window) {
    let energy = 0;
    for (let i = at; i < at + window; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    if (10 * Math.log10(energy / (window / 2) + 1e-12) > -45) end = at + window;
  }
  return end;
}

function wav(pcm: Uint8Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const ascii = new TextEncoder();
  out.set(ascii.encode("RIFF"), 0);
  view.setUint32(4, 36 + pcm.byteLength, true);
  out.set(ascii.encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  out.set(ascii.encode("data"), 36);
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", default: "ws://127.0.0.1:7817/relay" },
    agent: { type: "string", default: "astra" },
    wav: { type: "string" },
    barge: { type: "string" },
    out: { type: "string", default: "call-reply.wav" },
    timeout: { type: "string", default: "120" },
  },
});
if (values.wav === undefined) throw new Error("--wav <file> is required");
const question = pcmOf(values.wav);
const questionEnd = speechEnd(question);
const barge = values.barge === undefined ? null : pcmOf(values.barge);

const deviceId = `call-smoke-${randomBytes(4).toString("hex")}`;
const secret = randomBytes(32);
const devices = new FileDeviceStore();
devices.save(secret, deviceId, "Call smoke");

const callId = `smoke-${randomBytes(4).toString("hex")}`;
const t0 = performance.now();
const at = (): number => Math.round(performance.now() - t0);

/** What the run saw, filled in by the frame handlers (an object, so reads after `await` are not narrowed away). */
interface Marks {
  speechEndAt: number | null;
  heardAt: number | null;
  heard: string | null;
  /** The line the host said it is speaking when each line's first audio arrived. */
  firstAudio: { at: number; text: string }[];
  speaking: string | null;
  spoke: boolean;
  bargeSent: boolean;
  flushes: number;
  audioBytes: number;
  thread: AssistantMessage[];
}
const marks: Marks = { speechEndAt: null, heardAt: null, heard: null, firstAudio: [], speaking: null, spoke: false, bargeSent: false, flushes: 0, audioBytes: 0, thread: [] };
const timeline: { at: number; state: CallState; text?: string }[] = [];
const audio: Uint8Array[] = [];

const { promise: done, resolve: finish } = Promise.withResolvers<string>();
const socket = new WebSocket(values.host);
const send = (message: ClientMessage): void => {
  socket.send(encode(message));
};

/** What the microphone plays next; silence once it has run out, like a phone in a quiet room. */
let mic: { pcm: Uint8Array; offset: number; markEnd: number | null } = { pcm: new Uint8Array(0), offset: 0, markEnd: null };
let micOn = false;

/** Sends one 100 ms frame of the microphone at real time until the call ends. */
async function microphone(): Promise<void> {
  const quiet = Buffer.alloc(FRAME_BYTES).toString("base64");
  const started = performance.now();
  for (let frame = 0; micOn; frame += 1) {
    const wait = started + frame * FRAME_MS - performance.now();
    if (wait > 0) await Bun.sleep(wait);
    if (mic.offset >= mic.pcm.byteLength) {
      send({ t: "call.audio", callId, pcm: quiet });
      continue;
    }
    const chunk = mic.pcm.subarray(mic.offset, Math.min(mic.offset + FRAME_BYTES, mic.pcm.byteLength));
    mic.offset += chunk.byteLength;
    send({ t: "call.audio", callId, pcm: Buffer.from(chunk).toString("base64") });
    if (mic.markEnd !== null && marks.speechEndAt === null && mic.offset >= mic.markEnd) marks.speechEndAt = at();
  }
}

/** Plays `pcm` into the microphone from the next frame on; `markEnd` is where its speech ends. */
function talk(pcm: Uint8Array, markEnd: number | null): void {
  mic = { pcm, offset: 0, markEnd };
  if (micOn) return;
  micOn = true;
  void microphone();
}

function onFrame(message: ServerMessage): void {
  if (message.t === "challenge") send({ t: "auth", proof: createHmac("sha256", secret).update(message.nonce, "utf8").digest("hex") });
  else if (message.t === "welcome") {
    send({ t: "assistant.get", agent: values.agent });
    send({ t: "call.start", callId, agent: values.agent });
  } else if (message.t === "error") finish(`host error ${message.code}: ${message.message}`);
  else if (message.t === "assistant.snapshot" && message.agent === values.agent) marks.thread = message.snapshot.messages;
  else if (message.t === "call.flush") marks.flushes += 1;
  else if (message.t === "call.audio") {
    const pcm = Buffer.from(message.pcm, "base64");
    audio.push(pcm);
    marks.audioBytes += pcm.byteLength;
    const line = marks.speaking ?? "";
    if (!marks.firstAudio.some((entry) => entry.text === line)) marks.firstAudio.push({ at: at(), text: line });
    // Barge in on the second line said: the first may be the filler, the second is the agent's.
    if (barge !== null && !marks.bargeSent && marks.firstAudio.length >= 2) {
      marks.bargeSent = true;
      talk(barge, null);
    }
  } else if (message.t === "call.state" && message.callId === callId) {
    timeline.push({ at: at(), state: message.state, ...(message.text === undefined ? {} : { text: message.text }) });
    if (message.state === "listening" && !marks.spoke && marks.heardAt === null) talk(question, questionEnd);
    if (message.state === "thinking" && marks.heardAt === null && message.text !== undefined) {
      marks.heardAt = at();
      marks.heard = message.text;
    }
    if (message.state === "speaking") {
      marks.spoke = true;
      marks.speaking = message.text ?? null;
    }
    if (message.state === "listening" && marks.spoke) finish("done");
    if (message.state === "ended") finish(message.error === undefined ? "ended" : `ended: ${message.error}`);
  }
}

socket.onopen = () => {
  send({ t: "hello", v: 1, deviceId, deviceName: "Call smoke", platform: "ios" });
};
socket.onmessage = (event: MessageEvent<string>) => {
  const parsed = parseServerMessage(event.data);
  if (parsed.ok) onFrame(parsed.value);
};
socket.onclose = () => {
  finish("socket closed");
};
const timer = setTimeout(() => {
  finish("timeout");
}, Number(values.timeout) * 1000);

const outcome = await done;
clearTimeout(timer);
micOn = false;
send({ t: "call.end", callId });
// The snapshot of the turn arrives debounced; give the thread a moment to catch up.
await Bun.sleep(1500);
socket.close();
devices.forget(deviceId);
writeFileSync(values.out, wav(Buffer.concat(audio), CALL_OUTPUT_RATE));

const voiceTurn = [...marks.thread].reverse().find((message) => message.role === "user" && message.voice === true);
const replyRow = marks.thread.at(-1);
const replyText = replyRow?.role === "assistant" ? replyRow.text.replace(/\s+/g, " ") : "";
// A line the agent's reply does not contain is the filler.
const filler = marks.firstAudio.find((entry) => !replyText.includes(entry.text));
const firstReply = marks.firstAudio.find((entry) => replyText.includes(entry.text));
const end = marks.speechEndAt;
const since = (mark: number | null | undefined): number | null => (end === null || mark === null || mark === undefined ? null : mark - end);
process.stdout.write(
  `${JSON.stringify(
    {
      outcome,
      agent: values.agent,
      heard: marks.heard,
      filler: filler?.text ?? null,
      ms: {
        speechEndToTranscript: since(marks.heardAt),
        speechEndToFirstAudio: since(marks.firstAudio[0]?.at),
        speechEndToFirstReplyAudio: since(firstReply?.at),
      },
      flushes: marks.flushes,
      audioMs: Math.round((marks.audioBytes / 2 / CALL_OUTPUT_RATE) * 1000),
      out: values.out,
      thread: { voiceTurn: voiceTurn?.text ?? null, reply: replyText === "" ? null : replyText },
      timeline,
    },
    null,
    2,
  )}\n`,
);
process.exit(outcome === "done" ? 0 : 1);
