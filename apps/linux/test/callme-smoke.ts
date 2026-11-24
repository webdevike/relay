#!/usr/bin/env bun
// End-to-end smoke of "call me when it's done" without Isaac or a phone: a throwaway host (its own
// temp agent home, XDG_CONFIG_HOME, port 0, pushes captured, a scripted assistant) runs the real
// CallMeService, CallService, Deepgram engine and RelayServer. Two requests:
//   A. `relay-host call-me add` (the real CLI) on a fake agent-session run; the run's record flips to
//      done; the host rings (captured push); a fake phone answers with `call.start` + `request`;
//      Deepgram speaks the greeting that names the work (host log: `said "..."`).
//   B. `--on manual`, settled as failed, never answered: missed-call push and the card's result.
// Prints a JSON report; the host log goes to <dir>/host.log.
//
//   XDG_CONFIG_HOME=$(mktemp -d /tmp/relay-smoke-XXXX) RELAY_VOICE_PROVIDER=deepgram bun test/callme-smoke.ts --dir <tmp>
//
// The Deepgram key is linked by path from ~/Eva/secrets/deepgram.env into the temp agent home.

import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encode, parseServerMessage, type AgentMessage, type AgentSession, type CallState, type ClientMessage, type GuestEntry, type ServerMessage } from "@relay/protocol";
import { AskStore } from "../src/assistant/ask-store";
import { AssistantService, AssistantThreads } from "../src/assistant/service";
import { FileAssistantStore } from "../src/assistant/store";
import type { CallThread } from "../src/call/call";
import { CallService } from "../src/call/service";
import { CallMeService } from "../src/callme/service";
import { runsDir } from "../src/callme/work";
import { FileDeviceStore } from "../src/device-store";
import { TerminalPairingUI } from "../src/pairing";
import type { PushMessage } from "../src/push/notifier";
import { RelayServer } from "../src/server";
import { systemClock } from "../src/session";
import type { AgentProvider, AgentProviderChange } from "../src/seams";
import { composeVoiceEngines } from "../src/voice/engines";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { dir: { type: "string" }, timeout: { type: "string", default: "60" } } });
const dir = values.dir ?? "";
if (dir === "") throw new Error("--dir required");
if (!(process.env["XDG_CONFIG_HOME"] ?? "").startsWith("/tmp/relay-smoke-")) throw new Error("XDG_CONFIG_HOME must be /tmp/relay-smoke-*");
const home = join(dir, "home");
const runs = runsDir(home);
mkdirSync(join(home, "secrets"), { recursive: true });
mkdirSync(runs, { recursive: true });
try {
  symlinkSync(join(process.env["HOME"] ?? "", "Eva", "secrets", "deepgram.env"), join(home, "secrets", "deepgram.env"));
} catch {
  // linked already
}
const logFile = join(dir, "host.log");
const log = (line: string): void => {
  const row = `${new Date().toISOString()} ${line}\n`;
  appendFileSync(logFile, row);
  process.stderr.write(row);
};

// --- scripted assistant ----------------------------------------------------------------------
const ID = "nova";
const session: AgentSession = { id: "iso-1", provider: "omp", title: "Nova", projectPath: home, status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant", assistant: ID };
const transcript: AgentMessage[] = [];
const provider = {
  id: "omp",
  isAvailable: true,
  onChange: null as ((change: AgentProviderChange) => void) | null,
  get sessions() {
    return [session];
  },
  start: () => undefined,
  conversation: (sessionId: string) => Promise.resolve(sessionId === session.id ? [...transcript] : null),
  reply(_sessionId: string, text: string): Promise<void> {
    log(`fixture: turn "${text.slice(0, 160)}"`);
    return Promise.resolve();
  },
  note: () => Promise.resolve(true),
  pendingAsk: () => null,
  pendingApproval: () => null,
  gate: null,
} as unknown as AgentProvider & { onChange: ((change: AgentProviderChange) => void) | null };
const noPush = { tokens: () => new Map<string, string>(), unregister: () => undefined };
const thread = new AssistantService({
  agent: { id: ID, title: "Nova" },
  agents: provider,
  launch: () => Promise.reject(new Error("fixture never launches omp")),
  sessionFile: () => null,
  holder: () => null,
  close: () => Promise.resolve(),
  reconnected: () => Promise.resolve(),
  agentHome: home,
  store: new FileAssistantStore(join(dir, "nova.json")),
  asks: new AskStore(null, () => Date.now()),
  tokens: noPush,
  sender: { send: (messages) => Promise.resolve(messages.map(() => ({ ok: true as const }))) },
  broadcast: (message): void => {
    server.broadcastAssistant(ID, message);
  },
  isViewing: () => false,
  clock: systemClock,
  log,
  spawn: () => {
    throw new Error("no sign-in tool");
  },
});
const assistant = new AssistantThreads([thread], { broadcast: (m): void => { server.broadcastExcept(m, null); }, clock: systemClock, log });

// --- the code under test ---------------------------------------------------------------------
const pushes: Omit<PushMessage, "to">[] = [];
const cards: GuestEntry[] = [];
const callMe = new CallMeService({
  thread: (agent) => (agent === ID ? { id: ID, title: "Nova", sessionId: () => session.id, say: (text) => thread.say(text) } : undefined),
  sessions: () => provider.sessions,
  card: (_sessionId, content, entry) => {
    cards.push(entry);
    log(`card ${entry.work?.id ?? "?"} ${entry.work?.state ?? "?"} "${entry.work?.title ?? ""}"${entry.text === undefined ? "" : ` text "${entry.text}"`} | assistant reads: ${content}`);
    return Promise.resolve(true);
  },
  push: (message) => {
    pushes.push(message);
    log(`push ${JSON.stringify(message)}`);
  },
  runs,
  human: "Isaac",
  path: join(dir, "call-requests.json"),
  timing: { ringMs: 20_000, maxWaitMs: 600_000, pollMs: 500 },
  clock: systemClock,
  log,
});
const callThread = (id: string): CallThread | undefined =>
  id === ID ? { id, title: "Nova", session: () => thread.current(), turn: (text) => thread.turn(text), rows: async () => (await thread.snapshot()).messages, memory: () => Promise.resolve(null) } : undefined;
const engines = composeVoiceEngines(null, { agentHome: home, env: process.env });
const calls = new CallService({ thread: callThread, engines, voice: null, clock: systemClock, log, answer: (request, agent) => callMe.answer(request, agent) ?? undefined });
const hostToken = randomBytes(32).toString("hex");
const refuse = (): Promise<void> => Promise.reject(new Error("no input on the isolated host"));
const server: RelayServer = new RelayServer(
  { port: 0, hostName: "callme-smoke", version: "smoke", vncPort: 1 },
  {
    input: { handle: () => undefined }, text: { insert: refuse, press: refuse }, access: { granted: false }, images: { paste: refuse },
    agents: provider, devices: new FileDeviceStore(), push: null, notifier: null, drops: null, boards: null, inbox: null, assistant, calls, live: null, callMe,
    usage: null, stats: null, catchup: null, feed: null, reactions: null, bookmarks: null, dismissedCards: null, artifacts: null, activity: null, canvas: null,
    sessionFiles: null, studio: null, reviews: null, query: null, files: null, meetings: null, control: null, hostToken, canvasPage: () => "",
    pairing: new TerminalPairingUI(), log,
  },
);
const port = server.start();
log(`smoke host on ${String(port)} (voice ${engines.select(ID).transport})`);

const until = async (what: string, test: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
};
// The host runs in this process: the CLI must not block its event loop.
const cli = async (...args: string[]): Promise<string> => {
  const child = Bun.spawn(["bun", "src/main.ts", "call-me", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, RELAY_HOST_URL: `http://127.0.0.1:${String(port)}`, RELAY_HOST_TOKEN: hostToken, RELAY_ASSISTANT: ID },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const out = `${stdout}${stderr}`.trim();
  log(`cli call-me ${args.join(" ")} -> ${out}`);
  if (code !== 0) throw new Error(`call-me ${args[0] ?? ""} failed: ${out}`);
  return out;
};

// --- A: a run settles, Nova rings, the phone answers -----------------------------------------
const runId = "2026-11-24T16-00-00-solstice-waterfall-options";
writeFileSync(join(runs, `${runId}.json`), JSON.stringify({ id: runId, owner: ID, title: "Solstice waterfall options", state: "running" }));
const added = await cli("add", "--about", "the waterfall options");
const requestA = /^(call-[0-9a-f]+):/.exec(added)?.[1] ?? "";
const runTranscript = join(dir, "run.jsonl");
writeFileSync(runTranscript, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Three waterfall options are on the canvas: A is the cheapest, B has the best sightline, C needs a pump upgrade." }] } })}\n`);
await Bun.sleep(1_500);
writeFileSync(join(runs, `${runId}.json`), JSON.stringify({ id: runId, owner: ID, title: "Solstice waterfall options", state: "done", sessionFile: runTranscript }));
log("fixture: run marked done");
await until("the ring", () => pushes.some((push) => "callRequest" in push.data && push.data.callRequest === requestA));

// A fake phone: paired straight into the temp device store, answers the ring like the push tap does.
const deviceId = `callme-smoke-${randomBytes(4).toString("hex")}`;
const secret = randomBytes(32);
const devices = new FileDeviceStore();
devices.save(secret, deviceId, "Call-me smoke");
const callId = `smoke-${randomBytes(4).toString("hex")}`;
const states: { at: number; state: CallState }[] = [];
let audioBytes = 0;
const t0 = Date.now();
const { promise: greeted, resolve: greetDone } = Promise.withResolvers<string>();
const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/relay`);
const send = (message: ClientMessage): void => {
  socket.send(encode(message));
};
let mic: Timer | undefined;
socket.onopen = () => {
  send({ t: "hello", v: 1, deviceId, deviceName: "Call-me smoke", platform: "ios" });
};
socket.onmessage = (event: MessageEvent<string>) => {
  const parsed = parseServerMessage(event.data);
  if (!parsed.ok) return;
  const message: ServerMessage = parsed.value;
  if (message.t === "challenge") send({ t: "auth", proof: createHmac("sha256", secret).update(message.nonce, "utf8").digest("hex") });
  else if (message.t === "welcome") {
    send({ t: "call.start", callId, agent: ID, request: requestA });
    // A quiet microphone, 100 ms frames, like a phone held to the ear.
    const quiet = Buffer.alloc(3200).toString("base64");
    mic = setInterval(() => {
      send({ t: "call.audio", callId, pcm: quiet });
    }, 100);
  } else if (message.t === "call.audio" && message.callId === callId) audioBytes += Buffer.from(message.pcm, "base64").byteLength;
  else if (message.t === "call.state" && message.callId === callId) {
    states.push({ at: Date.now() - t0, state: message.state });
    if (message.state === "ended") greetDone(`ended: ${message.error ?? "no error"}`);
    // The greeting is over once the call listens again after speaking.
    if (message.state === "listening" && states.some((entry) => entry.state === "speaking")) greetDone("greeted");
  }
};
const outcomeA = await Promise.race([greeted, Bun.sleep(Number(values.timeout) * 1000).then(() => "timeout")]);
await Bun.sleep(1_500); // Deepgram's ConversationText for the greeting can trail its audio
clearInterval(mic);
send({ t: "call.end", callId });
await Bun.sleep(500);
socket.close();
devices.forget(deviceId);

// --- B: manual work fails, nobody answers ----------------------------------------------------
const addedB = await cli("add", "--about", "the CI build", "--on", "manual");
const requestB = /^(call-[0-9a-f]+):/.exec(addedB)?.[1] ?? "";
await cli("settle", requestB, "--failed", "--result", "2 of 214 tests failed in checkout.spec.ts");
await until("the miss", () => pushes.some((push) => push.title === "Missed call from Nova"), 30_000);
const listed = await cli("list", "--all");

server.stop();
const said = /said "([^"]*)"/.exec(await Bun.file(logFile).text())?.[1] ?? null;
const report = {
  A: {
    request: requestA,
    outcome: outcomeA,
    ring: pushes.find((push) => "callRequest" in push.data && push.data.callRequest === requestA) ?? null,
    callStates: states,
    greetingAudioMs: Math.round((audioBytes / 2 / 24_000) * 1000),
    greetingSpoken: said,
    namesTheWork: said?.includes("waterfall options") === true,
  },
  B: {
    request: requestB,
    missedPush: pushes.find((push) => push.title === "Missed call from Nova") ?? null,
    card: cards.filter((card) => card.work?.id === `call:${requestB}`).at(-1) ?? null,
  },
  list: listed,
  log: logFile,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.A.namesTheWork && report.B.missedPush !== null ? 0 : 1);
