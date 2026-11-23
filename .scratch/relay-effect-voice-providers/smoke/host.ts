#!/usr/bin/env bun
// Throwaway loopback host for issue 05's real-call smoke. NOT the live Relay host.
// Real code under test: composeVoiceEngines, CallService, LiveService, RelayServer, AssistantService.
// Isolated: temp agent home (keys symlinked by path), temp device store, temp assistant store, port 0,
// no push/input/Bonjour. The assistant is a deterministic fixture: it records every delegated turn
// and answers after --reply-ms with marker text.
//
//   XDG_CONFIG_HOME=<tmp> RELAY_VOICE_PROVIDER=deepgram bun host.ts --dir <tmp> [--reply-ms 1500] [--no-keys] [--local-stub]
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { AgentMessage, AgentSession } from "@relay/protocol";
import { AskStore } from "../../../apps/linux/src/assistant/ask-store";
import { AssistantService, AssistantThreads } from "../../../apps/linux/src/assistant/service";
import { FileAssistantStore } from "../../../apps/linux/src/assistant/store";
import type { CallThread, VoiceStack } from "../../../apps/linux/src/call/call";
import { CallService } from "../../../apps/linux/src/call/service";
import { FileDeviceStore } from "../../../apps/linux/src/device-store";
import { composeVoiceEngines } from "../../../apps/linux/src/voice/engines";
import { LiveService } from "../../../apps/linux/src/live/service";
import { TerminalPairingUI } from "../../../apps/linux/src/pairing";
import { RelayServer } from "../../../apps/linux/src/server";
import { systemClock } from "../../../apps/linux/src/session";
import type { AgentProvider, AgentProviderChange } from "../../../apps/linux/src/seams";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dir: { type: "string" },
    "reply-ms": { type: "string", default: "1500" },
    "no-keys": { type: "boolean", default: false },
    "local-stub": { type: "boolean", default: false },
  },
});
const dir = values.dir ?? "";
if (dir === "") throw new Error("--dir required");
// Isolation guard: the default device store lives under XDG_CONFIG_HOME, which must be a temp dir, never ~/.config.
if (!(process.env["XDG_CONFIG_HOME"] ?? "").startsWith("/tmp/relay-smoke-")) throw new Error("XDG_CONFIG_HOME must be /tmp/relay-smoke-*");
const replyMs = Number(values["reply-ms"]);
const home = join(dir, "home");
mkdirSync(join(home, "secrets"), { recursive: true });
mkdirSync(join(dir, "relay"), { recursive: true });
if (!values["no-keys"]) {
  // Keys by path only: symlinks to the host-only secret files, never read or printed here.
  for (const name of ["deepgram.env", "openai.env"]) {
    try { symlinkSync(join(process.env["HOME"] ?? "", "Eva", "secrets", name), join(home, "secrets", name)); } catch { /* exists */ }
  }
}
const ledger = join(dir, "delegations.jsonl");
const logFile = join(dir, "host.log");
const log = (line: string): void => {
  const row = `${new Date().toISOString()} ${line}\n`;
  appendFileSync(logFile, row);
  process.stdout.write(row);
};

// --- deterministic assistant fixture ---------------------------------------------------------
const ID = "smoke";
const session: { value: AgentSession } = {
  value: { id: "iso-1", provider: "omp", title: "Smoke", projectPath: home, status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant", assistant: ID },
};
const transcript: AgentMessage[] = [];
let turns = 0;
const emit = (change: AgentProviderChange): void => { provider.onChange?.(change); };
const setStatus = (status: AgentSession["status"]): void => {
  session.value = { ...session.value, status, lastActivityAt: Date.now() };
  emit({ kind: "sessions" });
};
const unsupported = (): never => { throw new Error("not used in the isolated host"); };
const provider = {
  id: "omp", isAvailable: true, onChange: null as ((change: AgentProviderChange) => void) | null,
  get sessions() { return [session.value]; },
  start: () => undefined,
  conversation: (sessionId: string) => Promise.resolve(sessionId === session.value.id ? [...transcript] : null),
  reply(sessionId: string, text: string): Promise<void> {
    if (sessionId !== session.value.id) return Promise.reject(new Error("unknown session"));
    const n = (turns += 1);
    appendFileSync(ledger, `${JSON.stringify({ n, receivedAt: Date.now(), text })}\n`);
    log(`fixture: delegation #${String(n)} received (${String(text.length)} chars)`);
    const user: AgentMessage = { id: `u${String(n)}`, role: "user", text, at: Date.now() };
    transcript.push(user);
    emit({ kind: "conversation", sessionId, appended: [user] });
    setStatus("working");
    setTimeout(() => {
      const id = `a${String(n)}`;
      const spoken = `Marker alpha ${String(n)} received. The fixture reply is ready.`;
      const full = `${spoken}\n[[details]]\nDETAILS-ONLY-${String(n)} must not be spoken.`;
      const row: AgentMessage = { id, role: "assistant", text: full, at: Date.now() };
      transcript.push(row);
      emit({ kind: "message", sessionId, id, text: full, streaming: false });
      emit({ kind: "conversation", sessionId, appended: [row] });
      log(`fixture: reply #${String(n)} sent after ${String(replyMs)} ms`);
      setStatus("idle");
    }, replyMs);
    return Promise.resolve();
  },
  note: () => Promise.resolve(true),
  launch: unsupported, options: unsupported, image: unsupported, configure: unsupported, abort: unsupported, end: unsupported,
  answerAsk: unsupported, cancelAsk: unsupported, pendingAsk: () => null, decideApproval: unsupported, pendingApproval: () => null,
  gate: null, runGate: unsupported,
} as unknown as AgentProvider & { onChange: ((change: AgentProviderChange) => void) | null };

const tokens = new Map<string, string>();
const threadService = new AssistantService({
  agent: { id: ID, title: "Smoke" }, agents: provider,
  launch: () => Promise.reject(new Error("fixture never launches omp")),
  sessionFile: () => null, holder: () => null, close: () => Promise.resolve(), reconnected: () => Promise.resolve(),
  agentHome: home, store: new FileAssistantStore(join(dir, "smoke.json")), asks: new AskStore(null, () => Date.now()),
  tokens: { tokens: () => tokens, unregister: () => undefined },
  sender: { send: (messages) => Promise.resolve(messages.map(() => ({ ok: true as const }))) },
  broadcast: (message): void => { server.broadcastAssistant(ID, message); },
  isViewing: () => false, clock: systemClock, log,
  spawn: () => { throw new Error("no sign-in tool"); },
});
const assistant = new AssistantThreads([threadService], { broadcast: (m): void => { server.broadcastExcept(m, null); }, clock: systemClock, log });
const callThread = (id: string): CallThread | undefined => {
  const thread = assistant.threads.find((candidate) => candidate.id === id);
  if (thread === undefined) return undefined;
  return {
    id: thread.id, title: thread.title,
    session: () => thread.current(), turn: (text) => thread.turn(text),
    rows: async () => (await thread.snapshot()).messages, memory: () => Promise.resolve(null),
  };
};

// The same composition main.ts uses: host config null, provider from $RELAY_VOICE_PROVIDER, keys from <agentHome>/secrets.
const engines = composeVoiceEngines(null, { agentHome: home, env: process.env });
// Local-call stand-in for the fallback scenario only: the real local stack (eva-realtime, pocket-tts) is not touched.
const stub: VoiceStack | null = values["local-stub"]
  ? {
      ears: () => Promise.resolve({ audio: () => undefined, reset: () => undefined, close: () => undefined }),
      filler: () => Promise.resolve("One moment."),
      speak: async function* () { /* silent */ },
      warm: () => undefined,
    }
  : null;
const calls = new CallService({ thread: callThread, engines, voice: stub, clock: systemClock, log });
const live = new LiveService({ thread: callThread, engines, voice: () => "marin", clock: systemClock, log });
const refuse = (): Promise<void> => Promise.reject(new Error("no input on the isolated host"));
const hostToken = "b".repeat(64);
const server: RelayServer = new RelayServer(
  { port: 0, hostName: "isolated-smoke", version: "smoke", vncPort: 1 },
  {
    input: { handle: () => undefined }, text: { insert: refuse, press: refuse }, access: { granted: false }, images: { paste: refuse },
    agents: provider, devices: new FileDeviceStore(),
    push: null, notifier: null, drops: null, boards: null, inbox: null, assistant, calls, live, usage: null, stats: null, catchup: null, feed: null,
    reactions: null, bookmarks: null, dismissedCards: null, artifacts: null, activity: null, canvas: null, sessionFiles: null, studio: null,
    reviews: null, query: null, files: null, meetings: null, control: null, hostToken, canvasPage: () => "", pairing: new TerminalPairingUI(), log,
  } as never,
);
const port = server.start();
writeFileSync(join(dir, "port"), String(port));
log(`engine=${engines.select(ID).id} transport=${engines.select(ID).transport}`);
log(`READY ${String(port)}`);
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
process.on("SIGINT", () => { server.stop(); process.exit(0); });
