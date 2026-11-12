#!/usr/bin/env bun
// A Relay Host with only the drop box (no input, agents, Bonjour or agent socket), for share
// regression checks (Eva's .omp/tests/share-embeds.test.ts): `share` uploads to it and the printed
// embed is probed against it. Run with XDG_CONFIG_HOME pointing into a temp dir so nothing touches
// the live host: drops go to `$XDG_CONFIG_HOME/relay/drops` and serve.json (port, pid,
// controlToken) next to them, where `share` finds it.
//
//   bun test/drops-host.ts [--port 0]      prints `ready <port>` once listening

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { relayConfigDir } from "../src/host-config";
import { FileDeviceStore } from "../src/device-store";
import { FileDropStore } from "../src/drops/store";
import { ffmpegProbe, maxVideoBytesFromEnv } from "../src/drops/video";
import { TerminalPairingUI } from "../src/pairing";
import { RelayServer } from "../src/server";

const { values } = parseArgs({ options: { port: { type: "string", default: "0" } } });
const log = (line: string): void => {
  console.error(`[drops-host] ${line}`);
};
const refuse = (): Promise<void> => Promise.reject(new Error("no input on the drops host"));
const hostToken = randomBytes(32).toString("hex");
const server = new RelayServer(
  { port: Number(values.port), hostName: "drops-e2e", version: "e2e", vncPort: 1 },
  {
    input: { handle: () => undefined },
    text: { insert: refuse, press: refuse },
    access: { granted: false },
    images: { paste: refuse },
    agents: null,
    devices: new FileDeviceStore(),
    push: null,
    notifier: null,
    drops: new FileDropStore(undefined, { maxVideoBytes: maxVideoBytesFromEnv(), probe: ffmpegProbe(log) }),
    boards: null,
    inbox: null,
    assistant: null,
    calls: null,
    live: null,
    usage: null,
    stats: null,
    catchup: null,
    feed: null,
    reactions: null,
    bookmarks: null,
    dismissedCards: null,
    artifacts: null,
    activity: null,
    canvas: null,
    sessionFiles: null,
    studio: null,
    reviews: null,
    query: null,
    files: null,
    meetings: null,
    control: null,
    hostToken,
    canvasPage: () => "",
    pairing: new TerminalPairingUI(),
    log,
  },
);
const port = server.start();
const serve = `${relayConfigDir()}/serve.json`;
mkdirSync(dirname(serve), { recursive: true });
writeFileSync(serve, JSON.stringify({ port, pid: process.pid, controlToken: hostToken }), { mode: 0o600 });
process.stdout.write(`ready ${String(port)}\n`);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
