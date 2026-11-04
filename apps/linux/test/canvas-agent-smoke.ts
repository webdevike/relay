#!/usr/bin/env bun
// Smoke test of the canvas self as a full agent, against a throwaway host started with
// `bun test/canvas-e2e.ts host --chat <transcript> --rows <rows>` (never the live host). It plays
// Isaac: starts a room on the test board from the transcript's chat, joins over y-websocket, asks
// for a clickable mockup at a card, then a tweak, then wraps up. It prints a transcript of the
// room (lines, status lines, cards) with times, what the agent spent and per minute, and every
// handoff the chat got (expected: none). Run with the host's XDG_CONFIG_HOME so pairing lands there:
//   bun test/canvas-agent-smoke.ts --port 7937 --slug agent-smoke --chat <transcript> --rows <rows>

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { encode, parseServerMessage, type ServerMessage } from "@relay/protocol";
import { DOC_KEYS, type ChatMsg, type Presence } from "@relay/canvas-live/shared";
import { FileDeviceStore } from "../src/device-store";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", default: "7937" },
    slug: { type: "string", default: "agent-smoke" },
    chat: { type: "string" },
    rows: { type: "string" },
    ask: { type: "string", default: "Can you make me a clickable mockup of the approvals inbox on the right? Rows I can select and an Approve button, filled with the kinds of things our assistants really ask me to approve (look at how Relay handles approvals in work/relay, don't make them up)." },
    tweak: { type: "string", default: "Nice. Make the button say Approve selected, and show a count of selected rows next to it." },
    timeout: { type: "string", default: "600" },
  },
});
const port = Number(values.port);
const slug = values.slug;
const base = `http://127.0.0.1:${String(port)}`;
const t0 = Date.now();
const deadline = t0 + Number(values.timeout) * 1000;
const transcript: string[] = [];
const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const say = (line: string): void => {
  transcript.push(`${stamp()}  ${line}`);
  process.stdout.write(`${stamp()}  ${line}\n`);
};
const until = async (check: () => boolean, what: string): Promise<void> => {
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

// 1. Start the room from the chat (what `relay-linux canvas start` does for an omp session).
const started = (await (
  await fetch(`${base}/canvas/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, prompt: "Design the approvals inbox together", caller: { sessionFile: values.chat } }) })
).json()) as { roomId?: string; agent?: { name: string }; error?: string };
if (started.roomId === undefined) throw new Error(`start failed: ${started.error ?? "?"}`);
say(`room ${started.roomId} started, canvas self ${started.agent?.name ?? "?"}`);

// 2. A throwaway device gets a token, then joins as Isaac.
const devices = new FileDeviceStore();
const deviceId = `canvas-smoke-${randomBytes(4).toString("hex")}`;
const secret = randomBytes(32);
devices.save(secret, deviceId, "Canvas smoke");
const relay = new WebSocket(`ws://127.0.0.1:${String(port)}/relay`);
const access = Promise.withResolvers<Extract<ServerMessage, { t: "canvas.access" }>>();
relay.onmessage = (event: MessageEvent<string>) => {
  const parsed = parseServerMessage(event.data);
  if (!parsed.ok) return;
  const m = parsed.value;
  if (m.t === "challenge") relay.send(encode({ t: "auth", proof: createHmac("sha256", secret).update(m.nonce, "utf8").digest("hex") }));
  if (m.t === "welcome") relay.send(encode({ t: "canvas.open", slug }));
  if (m.t === "canvas.access") access.resolve(m);
  if (m.t === "canvas.unavailable") access.reject(new Error(m.reason));
};
const relayOpen = Promise.withResolvers<undefined>();
relay.addEventListener("open", () => { relayOpen.resolve(undefined); }, { once: true });
await relayOpen.promise;
relay.send(encode({ t: "hello", v: 1, deviceId, deviceName: "Canvas smoke", platform: "ios" }));
const { token } = await access.promise;

const doc = new Y.Doc();
const awareness = new awarenessProtocol.Awareness(doc);
const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/canvas/${slug}/ws?token=${token}`);
ws.binaryType = "arraybuffer";
const frame = (type: number, write: (e: encoding.Encoder) => void): Uint8Array => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
};
ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  const decoder = decoding.createDecoder(new Uint8Array(event.data));
  const type = decoding.readVarUint(decoder);
  if (type === 0) {
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(decoder, reply, doc, "remote");
    if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
  } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), "remote");
};
doc.on("update", (update: Uint8Array, origin: unknown) => {
  if (origin !== "remote" && ws.readyState === WebSocket.OPEN) ws.send(frame(0, (e) => { syncProtocol.writeUpdate(e, update); }));
});
awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
  if (origin !== "remote" && ws.readyState === WebSocket.OPEN) ws.send(frame(1, (e) => { encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])); }));
});
const wsOpen = Promise.withResolvers<undefined>();
ws.addEventListener("open", () => { wsOpen.resolve(undefined); }, { once: true });
await wsOpen.promise;
ws.send(frame(0, (e) => { syncProtocol.writeSyncStep1(e, doc); }));

const nodes = doc.getMap<Y.Map<unknown>>(DOC_KEYS.nodes);
const chat = doc.getArray<ChatMsg>(DOC_KEYS.chat);
await until(() => nodes.size > 0, "the board");
awareness.setLocalState({ user: { name: "Isaac", color: "#0ea5e9", kind: "human" }, cursor: { x: 0, y: 0 }, selected: [] } satisfies Presence);
say("Isaac joined the room");

// The room as Isaac sees it: every line, status line, card and the agent's state.
const agent = (): Presence | undefined => [...(awareness.getStates() as Map<number, Presence>).values()].find((p) => p.user.kind === "agent");
let lastDoing: string | null | undefined;
let quietSince = Date.now();
let longestQuietMs = 0;
let busy = false;
/** Something Isaac can see happened (a line, a status line, a card): the end of a silent stretch. */
const signal = (): void => {
  if (busy) longestQuietMs = Math.max(longestQuietMs, Date.now() - quietSince);
  quietSince = Date.now();
};
awareness.on("change", () => {
  const p = agent();
  if (p === undefined) return;
  busy = p.status !== "idle";
  if (p.doing !== lastDoing) {
    lastDoing = p.doing;
    if (p.doing) {
      signal();
      say(`   [${p.user.name} status] ${p.doing}`);
    }
  }
});
chat.observe((event) => {
  for (const d of event.changes.delta) {
    if (!Array.isArray(d.insert)) continue;
    for (const m of d.insert as ChatMsg[]) {
      if (m.kind === "human") continue;
      signal();
      say(m.kind === "event" ? `   (${m.text})` : `${m.name}: ${m.text}`);
    }
  }
});
nodes.observe((event) => {
  for (const [id, change] of event.changes.keys) {
    if (change.action !== "add") continue;
    const n = nodes.get(id);
    signal();
    say(`   [card added] ${id} (${String(n?.get("type"))})${n?.get("type") === "proto" ? ` in ${String(n.get("system"))}` : ""}`);
  }
});
// Text typing into a card is visible too.
nodes.observeDeep(() => {
  signal();
});
const idleFor = async (ms: number, what: string): Promise<void> => {
  let since = Date.now();
  await until(() => {
    if (agent()?.status !== "idle") since = Date.now();
    return Date.now() - since > ms;
  }, what);
};

await until(() => chat.toArray().some((m) => m.kind === "agent"), "the opener");
await idleFor(4000, "the opener to finish");

// 3. Ask for a clickable mockup at the brief card.
const brief = nodes.has("brief") ? "brief" : ([...nodes.keys()][0] ?? "");
awareness.setLocalState({ ...(awareness.getLocalState() as Presence), selected: [brief] });
const askAt = Date.now();
quietSince = askAt;
say(`Isaac [on ${brief}]: ${values.ask}`);
chat.push([{ id: `n-ask-${Date.now().toString(36)}`, kind: "human", name: "Isaac", color: "#0ea5e9", text: values.ask, nodeIds: [brief], at: null, ts: Date.now() }]);
const protos = (): string[] => [...nodes.entries()].filter(([, n]) => n.get("type") === "proto").map(([id]) => id);
const bodyOf = (id: string): string => {
  const body = nodes.get(id)?.get("body");
  return body instanceof Y.Text ? body.toJSON() : "";
};
await until(() => protos().length > 0, "a prototype card");
const protoId = protos()[0] ?? "";
say(`   -> first proto on the board after ${((Date.now() - askAt) / 1000).toFixed(1)}s`);
await idleFor(5000, "the mockup turn to finish");
const before = bodyOf(protoId);

// 4. A tweak, at the prototype.
awareness.setLocalState({ ...(awareness.getLocalState() as Presence), selected: [protoId] });
const tweakAt = Date.now();
quietSince = tweakAt;
say(`Isaac [on ${protoId}]: ${values.tweak}`);
chat.push([{ id: `n-tweak-${Date.now().toString(36)}`, kind: "human", name: "Isaac", color: "#0ea5e9", text: values.tweak, nodeIds: [protoId], at: null, ts: Date.now() }]);
await until(() => bodyOf(protoId) !== before || protos().length > 1, "the tweak");
say(`   -> prototype changed after ${((Date.now() - tweakAt) / 1000).toFixed(1)}s`);
await idleFor(5000, "the tweak turn to finish");
const after = bodyOf(protoId);

// 5. What it cost, then wrap up.
const view = (await (await fetch(`${base}/canvas/sessions/${slug}`)).json()) as { usage: { requests: number; tokens: number; costUsd: number }; handoffs: unknown[] };
const minutes = (Date.now() - t0) / 60_000;
const wrap = (await (await fetch(`${base}/canvas/${slug}/end?token=${token}`, { method: "POST" })).json()) as { summary: string };
say(`wrap-up: ${wrap.summary}`);
const rows = values.rows !== undefined && existsSync(values.rows) ? readFileSync(values.rows, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as { kind: string; text?: string }) : [];
const handoffs = rows.filter((r) => r.kind === "handoff-to-chat");
ws.close();
relay.close();
devices.forget(deviceId);
process.stdout.write(
  `${JSON.stringify(
    {
      protoId,
      tweakLanded: after !== before,
      approveSelected: after.includes("Approve selected"),
      usageBeforeWrap: view.usage,
      minutes: Number(minutes.toFixed(2)),
      costPerMinuteUsd: Number((view.usage.costUsd / minutes).toFixed(3)),
      longestSilentGapWhileWorkingSec: Number((longestQuietMs / 1000).toFixed(1)),
      handoffsToChat: handoffs.length,
      openHandoffs: view.handoffs.length,
    },
    null,
    2,
  )}\n`,
);
process.exit(0);
