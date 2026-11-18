#!/usr/bin/env bun
// A Relay Host with only remote control (no input, agents, Bonjour or agent socket), for Relay
// Desktop's remote-control e2e (apps/desktop/e2e/remote-control.spec.ts) and relay-ctl smokes. Run
// with XDG_CONFIG_HOME pointing into a temp dir so nothing touches the live host: paired devices
// come from `$XDG_CONFIG_HOME/relay/devices.json`, and serve.json (port, pid, controlToken) goes
// next to it, where relay-ctl's RELAY_HOST_FILE can point.
//
//   bun test/control-host.ts [--port 0] [--mirror] [--canvases DIR] [--hold-writes MS]
//                                     prints `ready <port>` once listening
//
// `--mirror` adds the window mirror (`workspace.*`, kept in `$XDG_CONFIG_HOME/relay/workspace.json`)
// and `--canvases` serves that boards folder to desktops on other Macs (`canvas.file.req`), for
// apps/desktop/e2e/workspace-mirror.spec.ts.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { ControlRelay } from "../src/control/relay";
import { relayConfigDir } from "../src/host-config";
import { FileDeviceStore } from "../src/device-store";
import { TerminalPairingUI } from "../src/pairing";
import { RelayServer } from "../src/server";
import { systemClock } from "../src/session";
import { WorkspaceService, defaultWorkspacePath } from "../src/workspace/service";
import { CanvasFilesService } from "../src/canvas/files";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    mirror: { type: "boolean", default: false },
    canvases: { type: "string" },
    "hold-writes": { type: "string" },
  },
});
const log = (line: string): void => {
  console.error(`[control-host] ${line}`);
};
const refuse = (): Promise<void> => Promise.reject(new Error("no input on the e2e host"));
const control = new ControlRelay(randomBytes(32).toString("hex"), systemClock, log);
const workspace = values.mirror
  ? new WorkspaceService({ path: defaultWorkspacePath(), log, saveDelayMs: 0 })
  : null;
const canvasFiles =
  values.canvases === undefined ? null : new CanvasFilesService({ dir: values.canvases, log });
await canvasFiles?.start();
// `--hold-writes MS`: each board write from another Mac waits MS after printing
// `held <slug> <its text as base64>`, so a test can land a change on the Mini between that Mac's
// read and its write.
const hold = Number(values["hold-writes"] ?? 0);
if (canvasFiles && hold > 0) {
  const handle = canvasFiles.handle.bind(canvasFiles);
  canvasFiles.handle = async (req) => {
    if (req.op === "write") {
      const text = Buffer.from(req.text ?? "").toString("base64");
      process.stdout.write(`held ${req.slug ?? ""} ${text}\n`);
      await Bun.sleep(hold);
    }
    return handle(req);
  };
}
const server = new RelayServer(
  { port: Number(values.port), hostName: "control-e2e", version: "e2e", vncPort: 1 },
  {
    input: { handle: () => undefined },
    text: { insert: refuse, press: refuse },
    access: { granted: false },
    images: { paste: refuse },
    agents: null,
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
    control,
    workspace,
    canvasFiles,
    hostToken: control.token,
    canvasPage: () => "",
    pairing: new TerminalPairingUI(),
    log,
  },
);
const port = server.start();
const serve = `${relayConfigDir()}/serve.json`;
mkdirSync(dirname(serve), { recursive: true });
writeFileSync(serve, JSON.stringify({ port, pid: process.pid, controlToken: control.token }), {
  mode: 0o600,
});
process.stdout.write(`ready ${String(port)}\n`);
process.on("SIGTERM", () => {
  server.stop();
  process.exit(0);
});
