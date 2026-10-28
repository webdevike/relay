#!/usr/bin/env bun
// End-to-end proof of a live canvas against an isolated host and a real omp session, no phone or
// desktop involved. Two modes, run with XDG_CONFIG_HOME, XDG_RUNTIME_DIR and RELAY_AGENTS_SOCKET
// pointing into a temp dir so nothing touches the live host:
//
//   bun test/canvas-e2e.ts host --canvases <dir> [--port 7917]
//       a Relay host with only the agent bridge and live canvas (no input, no Bonjour), real
//       warm omp brains; leaves serve.json where `relay-linux canvas start` looks for it.
//   bun test/canvas-e2e.ts client --slug <slug> --note "<what Isaac says>" [--port 7917] [--wrap]
//       pairs itself as a throwaway device, `canvas.get` + `canvas.open`, joins the room over
//       y-websocket as Isaac, waits for the opener, says the note at the first node, waits for
//       the reply and its edits, optionally presses Wrap up; prints a JSON report with latencies.

import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { encode, parseServerMessage, type ServerMessage } from "@relay/protocol";
import { DOC_KEYS, type ChatMsg, type Presence, type ServerMetrics } from "@relay/canvas-live/shared";
import { defaultSocketPath, OmpBridgeProvider } from "../src/agents/bridge";
import { loadRegistry } from "../src/assistant/registry";
import { brainConfigOverlay, ompBrains, resolveOmp } from "../src/canvas/brain";
import { CANVAS_PAGE } from "../src/canvas/page";
import { CanvasService } from "../src/canvas/service";
import { FileDeviceStore } from "../src/device-store";
import { RelayServer } from "../src/server";
import { TerminalPairingUI } from "../src/pairing";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    port: { type: "string", default: "7917" },
    canvases: { type: "string" },
    slug: { type: "string" },
    note: { type: "string", default: "Tighten the root's body to one short line." },
    wrap: { type: "boolean", default: false },
    timeout: { type: "string", default: "90" },
  },
});
const port = Number(values.port);
const configDir = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "relay");
const log = (line: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
};

if (positionals[0] === "host") host();
else if (positionals[0] === "client") await client();
else throw new Error("usage: canvas-e2e.ts host|client ...");

function host(): void {
  if (process.env["XDG_CONFIG_HOME"] === undefined || process.env["RELAY_AGENTS_SOCKET"] === undefined) throw new Error("set XDG_CONFIG_HOME and RELAY_AGENTS_SOCKET to a temp dir");
  const canvasDir = values.canvases ?? "";
  if (canvasDir === "") throw new Error("missing --canvases <dir>");
  const omp = resolveOmp();
  if (omp === null) throw new Error("omp not found");
  const agents = new OmpBridgeProvider(defaultSocketPath(), log, null);
  const canvas = new CanvasService({
    canvasDir,
    chats: agents,
    registry: loadRegistry(join(homedir(), "Eva")),
    avatarsDir: join(homedir(), "Eva", "work", "assistant-avatars"),
    brains: ompBrains({ omp, profile: "personal", configs: [brainConfigOverlay(configDir)], log }),
    log,
  });
  const refuse = (): Promise<void> => Promise.reject(new Error("no input on the e2e host"));
  const server = new RelayServer(
    { port, hostName: "canvas-e2e", version: "e2e", vncPort: 1 },
    {
      input: { handle: () => undefined },
      text: { insert: refuse, press: refuse },
      access: { granted: false },
      images: { paste: refuse },
      agents,
      devices: new FileDeviceStore(),
      push: null,
      notifier: null,
      drops: null,
      boards: null,
      inbox: null,
      assistant: null,
      calls: null,
      live: null,
      usage: null,
      catchup: null,
      reactions: null,
      artifacts: null,
      canvas,
      sessionFiles: null,
      canvasPage: () => CANVAS_PAGE,
      // PINs print here, so a simulator on 127.0.0.1 can pair with this host (and never the live one).
      pairing: new TerminalPairingUI(),
      log,
    },
  );
  const bound = server.start();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "serve.json"), JSON.stringify({ port: bound, pid: process.pid }));
  log(`canvas e2e host on http://127.0.0.1:${String(bound)} (bridge ${defaultSocketPath()}, boards ${canvasDir}, omp ${omp})`);
  process.on("SIGTERM", () => {
    canvas.stop();
    server.stop();
    process.exit(0);
  });
}

async function client(): Promise<void> {
  const slug = values.slug ?? "";
  const deadline = Date.now() + Number(values.timeout) * 1000;
  const devices = new FileDeviceStore();
  const deviceId = `canvas-e2e-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32);
  devices.save(secret, deviceId, "Canvas e2e");
  const report: Record<string, unknown> = { slug, deviceId };
  try {
    // 1. Relay socket: rooms and a token.
    const relay = new WebSocket(`ws://127.0.0.1:${String(port)}/relay`);
    const frames: ServerMessage[] = [];
    const waitFrame = async <T extends ServerMessage["t"]>(t: T): Promise<Extract<ServerMessage, { t: T }>> => {
      for (;;) {
        const found = frames.find((f) => f.t === t);
        if (found !== undefined) {
          frames.splice(frames.indexOf(found), 1);
          return found as Extract<ServerMessage, { t: T }>;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${t}`);
        await Bun.sleep(20);
      }
    };
    relay.onmessage = (event: MessageEvent<string>) => {
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) return;
      const message = parsed.value;
      if (message.t === "challenge") relay.send(encode({ t: "auth", proof: createHmac("sha256", secret).update(message.nonce, "utf8").digest("hex") }));
      frames.push(message);
    };
    await new Promise((resolve) => { relay.addEventListener("open", resolve, { once: true }); });
    relay.send(encode({ t: "hello", v: 1, deviceId, deviceName: "Canvas e2e", platform: "ios" }));
    await waitFrame("welcome");
    relay.send(encode({ t: "canvas.get" }));
    const rooms = await waitFrame("canvas.rooms");
    report["rooms"] = rooms.rooms.map((r) => ({ slug: r.slug, live: r.live, agent: r.agent.name, chat: r.chat }));
    relay.send(encode({ t: "canvas.open", slug }));
    const access = await waitFrame("canvas.access");
    report["access"] = { path: access.path.replace(/token=[^&]+/, "token=…"), expiresAt: access.expiresAt };
    const base = `http://127.0.0.1:${String(port)}/canvas/${slug}`;
    report["page"] = (await fetch(`${base}/?token=${access.token}`)).status;
    report["me"] = await (await fetch(`${base}/me?token=${access.token}`)).json();
    report["badTokenWs"] = await new Promise((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${String(port)}/canvas/${slug}/ws?token=nope`);
      bad.onopen = () => {
        resolve("opened");
      };
      bad.onerror = () => {
        resolve("refused");
      };
    });

    // 2. The room, as Isaac, over the y-websocket protocol.
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/canvas/${slug}/ws?token=${access.token}`);
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
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), "remote");
      }
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote" && ws.readyState === WebSocket.OPEN) ws.send(frame(0, (e) => { syncProtocol.writeUpdate(e, update); }));
    });
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== "remote" && ws.readyState === WebSocket.OPEN) ws.send(frame(1, (e) => { encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed])); }));
    });
    await new Promise((resolve) => { ws.addEventListener("open", resolve, { once: true }); });
    ws.send(frame(0, (e) => { syncProtocol.writeSyncStep1(e, doc); }));
    const until = async (check: () => boolean, what: string): Promise<void> => {
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(5);
      }
    };
    const nodes = doc.getMap<Y.Map<unknown>>(DOC_KEYS.nodes);
    const chat = doc.getArray<ChatMsg>(DOC_KEYS.chat);
    await until(() => nodes.size > 0, "the board to sync");
    const joinedAt = performance.now();
    awareness.setLocalState({ user: { name: "Isaac", color: "#0ea5e9", kind: "human" }, cursor: { x: 0, y: 0 }, selected: [] } satisfies Presence);
    const agentState = (): Presence | undefined => [...(awareness.getStates() as Map<number, Presence>).values()].find((p) => p.user.kind === "agent");
    await until(() => chat.toArray().some((m) => m.kind === "agent"), "the opener");
    const opener = chat.toArray().find((m) => m.kind === "agent");
    report["opener"] = { ms: Math.round(performance.now() - joinedAt), said: opener?.text, agendaAdded: nodes.has("agenda"), decisionsAdded: nodes.has("decisions") };

    // 3. A note at the first node, and the reply.
    const target = [...nodes.keys()].find((id) => id !== "agenda" && id !== "decisions") ?? "";
    const before = JSON.stringify(nodes.toJSON());
    const cursorBefore = JSON.stringify(agentState()?.cursor);
    const note: ChatMsg = { id: `n-${Date.now().toString(36)}`, kind: "human", name: "Isaac", color: "#0ea5e9", text: values.note, nodeIds: [target], at: null, ts: Date.now() };
    awareness.setLocalState({ ...(awareness.getLocalState() as Presence), selected: [target] });
    const sentAt = performance.now();
    chat.push([note]);
    let cursorMs: number | null = null;
    let firstTokenMs: number | null = null;
    let firstEditMs: number | null = null;
    const watch = setInterval(() => {
      const now = performance.now() - sentAt;
      const agent = agentState();
      if (cursorMs === null && (agent?.status === "thinking" || JSON.stringify(agent?.cursor) !== cursorBefore)) cursorMs = now;
      if (firstTokenMs === null && (agent?.bubble?.text ?? "") !== "" && agent?.bubble?.replyTo === note.id) firstTokenMs = now;
      if (firstEditMs === null && JSON.stringify(nodes.toJSON()) !== before) firstEditMs = now;
    }, 2);
    await until(() => chat.toArray().some((m) => m.kind === "agent" && m.replyTo === note.id), "the reply");
    const doneMs = performance.now() - sentAt;
    clearInterval(watch);
    const server = doc.getMap(DOC_KEYS.metrics).get(`s:${note.id}`) as ServerMetrics | undefined;
    report["turn"] = {
      target,
      note: note.text,
      said: chat.toArray().find((m) => m.replyTo === note.id)?.text,
      client: { cursorMs, firstTokenMs, firstEditMs, doneMs: Math.round(doneMs) },
      server: server === undefined ? null : { cursor: server.cursor, firstToken: Math.round(server.firstToken), firstEdit: server.firstEdit === null ? null : Math.round(server.firstEdit), modelDone: Math.round(server.modelDone), done: Math.round(server.done), output: server.output },
      boardChanged: JSON.stringify(nodes.toJSON()) !== before,
    };

    // 4. Wrap up from the page's button.
    if (values.wrap) {
      const res = await fetch(`${base}/end?token=${access.token}`, { method: "POST" });
      report["wrapUp"] = { status: res.status, ...((await res.json()) as object) };
    }
    ws.close();
    relay.close();
    awareness.destroy();
  } finally {
    devices.forget(deviceId);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}
