#!/usr/bin/env bun
// End-to-end proof of a GPT-Live call with a real assistant, from the Mac, without a phone and
// without touching the running host: this branch's `LiveCall` (the code the host runs for
// `live.start`) creates a real GPT-Live session and answers its delegations, while
//   - the phone is `live_phone.py` (aiortc): a WebRTC peer with a microphone track and the
//     `oai-events` data channel, speaking WAVs and recording what it hears;
//   - the assistant thread is the RUNNING host's, reached as a throwaway paired device (written
//     straight into this machine's device store, forgotten at the end) with `assistant.turn`
//     and `assistant.snapshot`, so the turns land in the real thread and its memory.
// Prints a JSON report: latencies per question, transcripts, the thread rows, billed seconds.
//
//   uv venv /tmp/live-e2e-venv && VIRTUAL_ENV=/tmp/live-e2e-venv uv pip install aiortc numpy
//   bun test/live-smoke.ts --agent nova --ask "What time is it?" --ask "What's on my calendar tomorrow?"
//       [--python /tmp/live-e2e-venv/bin/python] [--host ws://127.0.0.1:7817/relay] [--out dir]
//
// Questions are spoken with macOS `say`. "Speech end" is when the phone finished playing the WAV.
// Differences from the iPhone: the thread's replies come from snapshots (the details marker is
// already folded into a paragraph break there, so a reply with details is said whole).

import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encode, parseServerMessage, type AgentSession, type AssistantSnapshot, type ClientMessage, type ServerMessage } from "@relay/protocol";
import { FileDeviceStore } from "../src/device-store";
import { LiveCall, type LiveThread } from "../src/live/call";
import { openAiKey, OpenAiLive } from "../src/live/openai";
import { systemClock } from "../src/session";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", default: "ws://127.0.0.1:7817/relay" },
    agent: { type: "string", default: "nova" },
    ask: { type: "string", multiple: true, default: ["What time is it?"] },
    python: { type: "string", default: "/tmp/live-e2e-venv/bin/python" },
    out: { type: "string", default: "live-smoke" },
    voice: { type: "string", default: "marin" },
    timeout: { type: "string", default: "240" },
    barge: { type: "string" },
  },
});
mkdirSync(values.out, { recursive: true });
const key = openAiKey(process.env["RELAY_AGENT_HOME"] ?? join(process.env["HOME"] ?? "", "Eva"));
if (key === null) throw new Error("no OpenAI key ($OPENAI_API_KEY or ~/Eva/secrets/openai.env)");

/** `text` said by macOS into a 48 kHz mono WAV for the phone's microphone. */
function spoken(text: string, index: number): string {
  const aiff = join(values.out, `q${String(index)}.aiff`);
  const wav = join(values.out, `q${String(index)}.wav`);
  const say = Bun.spawnSync(["say", "-v", "Samantha", "-o", aiff, text]);
  if (say.exitCode !== 0) throw new Error(`say: ${say.stderr.toString()}`);
  const ff = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", aiff, "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", wav]);
  if (ff.exitCode !== 0) throw new Error(`ffmpeg: ${ff.stderr.toString()}`);
  return wav;
}
const questions = values.ask.map((text, index) => ({ text, wav: spoken(text, index) }));
const bargeWav = values.barge === undefined ? null : spoken(values.barge, questions.length);

const t0 = Date.now();
const rel = (at: number): number => at - t0;
const events: { at: number; what: string }[] = [];
const mark = (what: string, at = Date.now()): void => {
  events.push({ at: rel(at), what });
};

// --- The running host, as a throwaway paired phone --------------------------------------------
const deviceId = `live-smoke-${randomBytes(4).toString("hex")}`;
const secret = randomBytes(32);
const devices = new FileDeviceStore();
devices.save(secret, deviceId, "Live smoke");
const socket = new WebSocket(values.host);
const sendHost = (message: ClientMessage): void => {
  socket.send(encode(message));
};
let snapshot: AssistantSnapshot | null = null;
const acks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
const { promise: welcomed, resolve: welcome } = Promise.withResolvers<undefined>();
const { promise: firstSnapshot, resolve: gotSnapshot } = Promise.withResolvers<undefined>();
let call: LiveCall | null = null;
/** Assistant rows in the thread before the call: never said. */
const before = new Set<string>();

function session(): AgentSession | undefined {
  if (snapshot === null || snapshot.sessionId === "") return undefined;
  return { id: snapshot.sessionId, provider: "omp", title: values.agent, projectPath: "", status: snapshot.busy ? "working" : "idle", lastActivity: "", lastActivityAt: 0, canRespond: true, kind: "assistant", assistant: values.agent };
}

function onHost(message: ServerMessage): void {
  if (message.t === "challenge") sendHost({ t: "auth", proof: createHmac("sha256", secret).update(message.nonce, "utf8").digest("hex") });
  else if (message.t === "welcome") welcome(undefined);
  else if (message.t === "ack") acks.get(message.id)?.resolve();
  else if (message.t === "nack") acks.get(message.id)?.reject(new Error(`${message.error.code}: ${message.error.message}`));
  else if (message.t === "assistant.snapshot" && message.agent === values.agent) {
    const first = snapshot === null;
    snapshot = message.snapshot;
    if (first) {
      for (const row of snapshot.messages) before.add(row.id);
      gotSnapshot(undefined);
      return;
    }
    if (call === null) return;
    call.observe({ kind: "sessions" });
    const rows = snapshot.messages;
    rows.forEach((row, index) => {
      if (row.role !== "assistant" || before.has(row.id) || snapshot === null) return;
      call?.observe({ kind: "message", sessionId: snapshot.sessionId, id: row.id, text: row.text, streaming: snapshot.busy && index === rows.length - 1 });
    });
  }
}
socket.onopen = () => {
  sendHost({ t: "hello", v: 1, deviceId, deviceName: "Live smoke", platform: "ios" });
};
socket.onmessage = (event: MessageEvent<string>) => {
  const parsed = parseServerMessage(event.data);
  if (parsed.ok) onHost(parsed.value);
};

const thread: LiveThread = {
  id: values.agent,
  title: values.agent.charAt(0).toUpperCase() + values.agent.slice(1),
  session,
  turn: (text) => {
    const id = randomBytes(6).toString("hex");
    const { promise, resolve, reject } = Promise.withResolvers<undefined>();
    acks.set(id, {
      resolve: () => {
        resolve(undefined);
      },
      reject,
    });
    mark("turn sent to the thread");
    sendHost({ t: "cmd", id, cmd: { kind: "assistant.turn", agent: values.agent, text } });
    return promise.then(() => {
      mark("turn acked by the host");
    });
  },
  rows: () => Promise.resolve(snapshot?.messages ?? []),
};

await welcomed;
sendHost({ t: "assistant.get", agent: values.agent });
await firstSnapshot;

// --- The phone ----------------------------------------------------------------------------------
const phone = Bun.spawn([values.python, join(import.meta.dir, "live_phone.py"), "--out", join(values.out, "heard.wav")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const tellPhone = (command: Record<string, unknown>): void => {
  void phone.stdin.write(`${JSON.stringify(command)}\n`);
  void phone.stdin.flush();
};
type PhoneLine = { t: "offer"; sdp: string } | { t: "event"; at: number; event: { type: string } & Record<string, unknown> } | { t: "audio"; at: number; on: boolean } | { t: "played"; at: number; name: string } | { t: "closed"; at: number };
const transcript: { at: number; who: "isaac" | "voice"; text: string }[] = [];
/** The voice's transcript pieces as they arrived (wall clock), for what it said per question. */
const voiceDeltas: { at: number; text: string }[] = [];
const audioOn: number[] = [];
const audioOff: number[] = [];
const played: { at: number; name: string }[] = [];
/** Set by the phone and call handlers (an object, so reads after `await` are not narrowed away). */
const marks: { sessionStartedAt: number | null; billedSeconds: number | null; answerAt: number | null } = { sessionStartedAt: null, billedSeconds: null, answerAt: null };
const { promise: offered, resolve: offer } = Promise.withResolvers<string>();
const { promise: phoneClosed, resolve: closePhone } = Promise.withResolvers<undefined>();

async function readPhone(): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of phone.stdout) {
    buffer += decoder.decode(chunk);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = JSON.parse(buffer.slice(0, newline)) as PhoneLine;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line.t === "offer") offer(line.sdp);
      else if (line.t === "audio") {
        (line.on ? audioOn : audioOff).push(line.at);
        mark(line.on ? "phone hears the voice" : "voice went quiet", line.at);
      } else if (line.t === "played") {
        played.push({ at: line.at, name: line.name });
        mark(`phone finished saying ${line.name}`, line.at);
      } else if (line.t === "closed") closePhone(undefined);
      else {
        const event = line.event;
        if (event.type === "session.started") {
          marks.sessionStartedAt = line.at;
          mark("phone: session.started", line.at);
        } else if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
          const who = event.type === "session.input_transcript.delta" ? "isaac" : "voice";
          const delta = typeof event["delta"] === "string" ? event["delta"] : "";
          const last = transcript.at(-1);
          if (last?.who === who) last.text += delta;
          else transcript.push({ at: rel(line.at), who, text: delta });
          if (who === "voice") voiceDeltas.push({ at: line.at, text: delta });
        } else if (event.type === "session.closed") {
          const usage = event["usage"];
          marks.billedSeconds = typeof usage === "object" && usage !== null && "seconds" in usage && typeof usage.seconds === "number" ? usage.seconds : null;
        }
      }
    }
  }
  closePhone(undefined);
}
void readPhone();

const offerSdp = await offered;

// --- The call (this branch's host code) ---------------------------------------------------------
const callLog: { at: number; line: string }[] = [];
const states: { at: number; state: string; text?: string }[] = [];
const handed: number[] = [];
const delegations: number[] = [];
const pressAt = Date.now();
mark("press (live.start)");
call = new LiveCall({
  callId: `smoke-${randomBytes(3).toString("hex")}`,
  thread,
  api: new OpenAiLive(key),
  voice: values.voice,
  send: (message) => {
    if (message.t === "live.answer") {
      marks.answerAt = Date.now();
      mark("live.answer to the phone");
      tellPhone({ t: "answer", sdp: message.sdp });
    } else if (message.t === "live.state") {
      states.push({ at: rel(Date.now()), state: message.state, ...(message.text === undefined ? {} : { text: message.text }) });
      if (message.error !== undefined) mark(`ended: ${message.error}`);
    }
  },
  clock: systemClock,
  log: (line) => {
    const at = Date.now();
    callLog.push({ at: rel(at), line });
    if (line.includes(": delegation ")) delegations.push(at);
    if (line.includes("first reply handed")) handed.push(at);
    console.error(`+${String(rel(at))}ms ${line}`);
  },
  onEnded: () => undefined,
});
void call.start(offerSdp);

const deadline = Date.now() + Number(values.timeout) * 1000;
const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const until = Math.min(deadline, Date.now() + ms);
  while (!check()) {
    if (Date.now() > until) return false;
    await Bun.sleep(50);
  }
  return true;
};
/** Waits until the voice has been quiet for `quietMs` (or `ms` passes). */
const quiet = async (quietMs: number, ms: number): Promise<void> => {
  await waitFor(() => {
    const lastOn = audioOn.at(-1) ?? 0;
    const lastOff = audioOff.at(-1) ?? 0;
    return lastOff >= lastOn && Date.now() - Math.max(lastOff, lastOn) > quietMs;
  }, ms);
};

// Greeting: wait for the voice to speak and finish (or 6 s).
await waitFor(() => audioOn.length > 0, 10_000);
await quiet(800, 8_000);

const results = [];
for (const [index, question] of questions.entries()) {
  const name = `q${String(index)}`;
  const delegationsBefore = delegations.length;
  const handedBefore = handed.length;
  const statesBefore = states.length;
  tellPhone({ t: "play", wav: question.wav, name });
  await waitFor(() => played.some((entry) => entry.name === name), 20_000);
  const speechEnd = played.find((entry) => entry.name === name)?.at ?? Date.now();
  // Delegated: Nova's turn finishes (listening after thinking) and the voice says it. A question
  // the voice answers itself never goes to thinking.
  const delegated = await waitFor(() => states.slice(statesBefore).some((s) => s.state === "thinking"), 4_000);
  if (delegated) {
    await waitFor(() => {
      const later = states.slice(statesBefore);
      const thinking = later.findIndex((s) => s.state === "thinking");
      return thinking !== -1 && later.slice(thinking).some((s) => s.state === "listening");
    }, 150_000);
  }
  const handedAt = handed[handedBefore] ?? null;
  if (handedAt !== null) await waitFor(() => audioOn.some((at) => at > handedAt), 10_000);
  const isLast = index === questions.length - 1;
  let barge: { at: number; voiceStoppedAfterMs: number | null } | null = null;
  if (isLast && bargeWav !== null) {
    // Talk over the answer once it has been playing for a second.
    await Bun.sleep(1_000);
    tellPhone({ t: "play", wav: bargeWav, name: "barge" });
    const bargeAt = Date.now();
    await waitFor(() => audioOff.some((at) => at > bargeAt), 5_000);
    const stopped = audioOff.find((at) => at > bargeAt) ?? null;
    // live_phone.py reports "off" after 500 ms of quiet; the voice stopped that much earlier.
    barge = { at: rel(bargeAt), voiceStoppedAfterMs: stopped === null ? null : stopped - 500 - bargeAt };
  }
  await quiet(1_500, 30_000);
  const firstAudio = audioOn.find((at) => at > speechEnd) ?? null;
  const answerAudio = handedAt === null ? null : (audioOn.find((at) => at > handedAt) ?? null);
  const since = (at: number | null | undefined): number | null => (at === null || at === undefined ? null : at - speechEnd);
  results.push({
    question: question.text,
    answeredBy: delegated ? "nova (delegated)" : "voice",
    voiceSaid: voiceDeltas
      .filter((entry) => entry.at > speechEnd)
      .map((entry) => entry.text)
      .join("")
      .trim(),
    ms: {
      speechEndToFirstAudio: since(firstAudio),
      speechEndToDelegation: since(delegations[delegationsBefore]),
      speechEndToAnswerHanded: since(handedAt),
      speechEndToAnswerAudio: since(answerAudio ?? (delegated ? null : firstAudio)),
      answerHandedToAnswerAudio: answerAudio === null || handedAt === null ? null : answerAudio - handedAt,
    },
    ...(barge === null ? {} : { barge }),
  });
  voiceDeltas.length = 0;
}

call.end();
tellPhone({ t: "close" });
await Promise.race([phoneClosed, Bun.sleep(8_000)]);
phone.kill();
await Bun.sleep(1_500);
const thread_ = snapshot as AssistantSnapshot | null;
const rows = (thread_?.messages ?? []).filter((row) => !before.has(row.id)).map((row) => ({ role: row.role, voice: row.voice === true, text: row.text }));
socket.close();
devices.forget(deviceId);
const report = {
  agent: values.agent,
  ms: {
    pressToAnswer: marks.answerAt === null ? null : marks.answerAt - pressAt,
    pressToSessionStarted: marks.sessionStartedAt === null ? null : marks.sessionStartedAt - pressAt,
    pressToFirstAudio: audioOn[0] === undefined ? null : audioOn[0] - pressAt,
  },
  questions: results,
  billedSeconds: marks.billedSeconds,
  transcript,
  thread: rows,
  states,
  events,
  callLog,
  heard: join(values.out, "heard.wav"),
};
writeFileSync(join(values.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(0);
