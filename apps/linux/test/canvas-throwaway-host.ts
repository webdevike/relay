#!/usr/bin/env bun
// A throwaway Relay host for Relay Desktop's e2e: the real RelayServer and CanvasService (the real
// room page, y-websocket and board file) with a scripted mind instead of omp, no input, Bonjour or
// phones. Nothing here touches the live host: it takes its own relay dir (serve.json and
// devices.json, which the desktop adds itself to), boards folder and agent home.
//
//   RELAY_AGENTS_SOCKET=<tmp>/agents.sock bun test/canvas-throwaway-host.ts --relay-dir <dir> --canvases <dir> --home <dir>
//
// Nova's assistant thread is "running" (its transcript is <home>/nova.jsonl), so `POST
// /canvas/sessions {caller: {assistant: "nova"}}` starts a room. The scripted mind answers every
// turn with one plain line: "Seen. On it." in the comment's thread, "Here when you want me." as
// the opener. Prints `READY <port>` once listening.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultSocketPath, OmpBridgeProvider } from "../src/agents/bridge";
import type { CanvasMind, MindSetup, TurnHandlers } from "../src/canvas/brain";
import { CANVAS_PAGE } from "../src/canvas/page";
import { CanvasService, type CanvasChats } from "../src/canvas/service";
import { FileDeviceStore } from "../src/device-store";
import { TerminalPairingUI } from "../src/pairing";
import { RelayServer } from "../src/server";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { "relay-dir": { type: "string" }, canvases: { type: "string" }, home: { type: "string" } },
});
const relayDir = values["relay-dir"] ?? "";
const canvasDir = values.canvases ?? "";
const home = values.home ?? "";
if (relayDir === "" || canvasDir === "" || home === "") throw new Error("usage: --relay-dir <dir> --canvases <dir> --home <dir>");
const log = (line: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
};

class ScriptedMind implements CanvasMind {
  readonly usage = { requests: 0, tokens: 0, costUsd: 0 };
  readonly exhausted = null;
  async turn(message: string, on: TurnHandlers): Promise<void> {
    this.usage.requests += 1;
    on.text(message.includes("# Session start") || !message.includes("# The comment") ? "Here when you want me." : "Seen. On it.");
    on.textEnd();
    await Promise.resolve();
  }
  steer(): boolean {
    return false;
  }
  setModel(): void {}
  dispose(): void {}
}

mkdirSync(canvasDir, { recursive: true });
mkdirSync(relayDir, { recursive: true });
const novaFile = join(home, "nova.jsonl");
mkdirSync(home, { recursive: true });
writeFileSync(novaFile, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Nova, help me with my boards" }] } })}\n`);
const nova = { id: "s-nova", provider: "omp" as const, title: "Nova", projectPath: home, status: "idle" as const, lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant" as const, assistant: "nova" };
const chats: CanvasChats = {
  sessions: [nova],
  sessionForFile: (file) => (file === novaFile ? nova : null),
  sessionFile: (id) => (id === nova.id ? novaFile : null),
  canvas: () => Promise.resolve(true),
  reply: () => Promise.resolve(),
};
const canvas = new CanvasService({
  canvasDir,
  chats,
  registry: [{ id: "nova", title: "Nova", avatar: "nova-17", portrait: { style: "micah", seed: "nova-17", colors: { accent: "#f76707" } } }],
  minds: (_setup: MindSetup) => new ScriptedMind(),
  log,
  agentHome: home,
  pacing: { frameMs: 0, typeMs: 0 },
});
const refuse = (): Promise<void> => Promise.reject(new Error("no input on the throwaway host"));
const server = new RelayServer(
  { port: 0, hostName: "throwaway", version: "e2e", vncPort: 1 },
  {
    input: { handle: () => undefined },
    text: { insert: refuse, press: refuse },
    access: { granted: false },
    images: { paste: refuse },
    agents: new OmpBridgeProvider(defaultSocketPath(), log, null),
    devices: new FileDeviceStore(join(relayDir, "devices.json")),
    push: null,
    notifier: null,
    drops: null,
    boards: null,
    inbox: null,
    assistant: null,
    calls: null,
    live: null,
    usage: null,
    stats: null,
    catchup: null,
    reactions: null,
    bookmarks: null,
    artifacts: null,
    activity: null,
    canvas,
    sessionFiles: null,
    studio: null,
    reviews: null,
    query: null,
    files: null,
    meetings: null,
    control: null,
    canvasPage: () => CANVAS_PAGE,
    pairing: new TerminalPairingUI(),
    log,
  },
);
const port = server.start();
writeFileSync(join(relayDir, "serve.json"), JSON.stringify({ port, pid: process.pid }));
log(`READY ${String(port)}`);
process.on("SIGTERM", () => {
  canvas.stop();
  server.stop();
  process.exit(0);
});
