#!/usr/bin/env bun
// Relay host for Windows. The phone side is the Linux host's own transport (apps/linux:
// RelayServer, ClientSession, pairing, command dedup, device store, trackpad and keyboard
// models, VNC bridge) with Windows input underneath, so phones and Relay desktop pair with it
// unchanged. The agent channel (`agent/server.ts`) is Windows-only: it is how agents on the Mac
// Mini run commands, launch apps, take screenshots and use the clipboard in Isaac's session.
//
//   relay-host serve [--name NAME] [--port 7817] [--listen tailnet|ADDR] [--agent-port 7818] [--vnc-port 5900]
//   relay-host devices
//   relay-host forget <deviceId>
//
// Agents, assistants, boards, drops and the rest of the Eva runtime stay on the Mac; this host only
// carries what has to run on the PC.

/* eslint-disable no-console -- the daemon's console (redirected to host.log by the logon task) is its UI */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FileDeviceStore } from "@relay/linux/src/device-store";
import { relayConfigDir } from "@relay/linux/src/host-config";
import { KeyboardInjector } from "@relay/linux/src/input/keyboard";
import { ClipboardPaster } from "@relay/linux/src/input/paste";
import { TrackpadInputSink } from "@relay/linux/src/input/trackpad";
import { PinFilePairingUI, TerminalPairingUI } from "@relay/linux/src/pairing";
import { RelayServer } from "@relay/linux/src/server";
import { isTailnetAddress, PAIRING_TIMEOUT_MS } from "@relay/linux/src/session";
import { DEFAULT_VNC_PORT } from "@relay/linux/src/vnc";
import pkg from "../package.json" with { type: "json" };
import { checkRunRequest, runCommand } from "./agent/command";
import { launch, startProcess } from "./agent/launch";
import { startAgentServer } from "./agent/server";
import {
  focusWindow,
  listWindows,
  readClipboardText,
  shootScreen,
  shootWindow,
  writeClipboardText,
} from "./desktop";
import { WindowsInputDevice } from "./input";
import { WindowsBonjourAdvertiser } from "./mdns";
import { becomeDpiAware, sendInput } from "./win32";

const DEFAULT_PORT = 7817;
const DEFAULT_AGENT_PORT = 7818;

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

/** The agent channel's token file; the install script creates it (ACL: Isaac only). */
function agentKeyPath(): string {
  return process.env["RELAY_AGENT_KEY_FILE"] ?? join(homedir(), ".relay", "agent.key");
}

function tailnetAddress(): string | null {
  return (
    Object.values(networkInterfaces())
      .flat()
      .find((a) => a?.family === "IPv4" && isTailnetAddress(a.address))?.address ?? null
  );
}

/** Tailscale may still be starting at logon: wait for its address rather than fall back to the LAN. */
async function waitForTailnet(): Promise<string> {
  let logged = false;
  for (;;) {
    const address = tailnetAddress();
    if (address !== null) return address;
    if (!logged) log("waiting for a Tailscale address (100.64.0.0/10) to listen on");
    logged = true;
    await Bun.sleep(5_000);
  }
}

/** A phone image onto the clipboard (.NET's SetImage needs an STA thread, which Windows PowerShell's is). */
async function copyImage(_mimeType: string, bytes: Uint8Array): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "relay-paste-"));
  const file = join(dir, "image");
  writeFileSync(file, bytes);
  try {
    const result = await runCommand(
      {
        command: [
          "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
          `$image = [Drawing.Image]::FromFile('${file.replaceAll("'", "''")}')`,
          "[Windows.Forms.Clipboard]::SetImage($image)",
          "$image.Dispose()",
        ].join("\n"),
        timeoutMs: 15_000,
      },
      new AbortController().signal,
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ServeOptions {
  readonly name: string;
  readonly port: number;
  /** `tailnet` (default) or a literal address. */
  readonly listen: string;
  readonly agentPort: number;
  readonly vncPort: number;
}

async function serve(options: ServeOptions): Promise<void> {
  log(`relay-host ${pkg.version} (Windows) pid ${process.pid}`);
  if (!becomeDpiAware()) log("DPI awareness was already set; screenshots and rects may be scaled");
  const device = new WindowsInputDevice(sendInput);
  const listenAddress = options.listen === "tailnet" ? await waitForTailnet() : options.listen;
  const server = new RelayServer(
    { port: options.port, hostName: options.name, version: pkg.version, vncPort: options.vncPort, listenAddress },
    {
      input: new TrackpadInputSink(device),
      text: new KeyboardInjector(device, device.typeText.bind(device)),
      access: { granted: true },
      images: new ClipboardPaster({ poster: device, copy: copyImage, expect: null }),
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
      control: null,
      hostToken: randomBytes(32).toString("hex"),
      canvasPage: () => "",
      pairing: new PinFilePairingUI(new TerminalPairingUI(), join(relayConfigDir(), "pairing.json"), PAIRING_TIMEOUT_MS),
      log,
    },
  );
  const port = server.start();
  log(`listening on ws://${listenAddress}:${port}/relay as "${options.name}"`);
  log(`live view: VNC bridge to 127.0.0.1:${options.vncPort} (answers vnc.unavailable while no VNC server listens there)`);

  const advertiser = new WindowsBonjourAdvertiser(options.name, port, tailnetAddress(), log);
  try {
    advertiser.start();
    log("advertising _relay._tcp via Windows DNS-SD");
  } catch (error) {
    log(`mDNS advertising off: ${error instanceof Error ? error.message : String(error)}; add this host by address (${listenAddress}:${port})`);
  }

  const keyPath = agentKeyPath();
  const token = existsSync(keyPath) ? readFileSync(keyPath, "utf8").trim() : "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    log(`agent channel off: ${keyPath} is missing or not 64 hex characters (the install script writes it)`);
  } else {
    const agentPort = startAgentServer(options.agentPort, {
      token,
      version: pkg.version,
      run: runCommand,
      checkRun: checkRunRequest,
      launch: (request) => launch(request, { listWindows, focusWindow, start: startProcess, sleep: Bun.sleep }),
      windows: listWindows,
      focus: focusWindow,
      shotScreen: shootScreen,
      shotWindow: shootWindow,
      readClipboard: readClipboardText,
      writeClipboard: writeClipboardText,
      log,
    });
    log(`agent channel on http://127.0.0.1:${agentPort} (token ${keyPath})`);
  }

  const stop = (): void => {
    advertiser.stop();
    device.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command = "serve", ...rest] = argv;
  switch (command) {
    case "serve": {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          name: { type: "string", default: hostname() },
          port: { type: "string", default: String(DEFAULT_PORT) },
          listen: { type: "string", default: "tailnet" },
          "agent-port": { type: "string", default: String(DEFAULT_AGENT_PORT) },
          "vnc-port": { type: "string", default: String(DEFAULT_VNC_PORT) },
        },
      });
      await serve({
        name: values.name,
        port: Number(values.port),
        listen: values.listen,
        agentPort: Number(values["agent-port"]),
        vncPort: Number(values["vnc-port"]),
      });
      return;
    }
    case "devices":
      for (const device of new FileDeviceStore().pairedDevices())
        console.log(`${device.id}  ${device.name}  paired ${new Date(device.pairedAt).toISOString()}`);
      return;
    case "forget": {
      const id = rest[0];
      if (id === undefined) throw new Error("usage: relay-host forget <deviceId>");
      new FileDeviceStore().forget(id);
      console.log(`forgot ${id}`);
      return;
    }
    default:
      throw new Error(`unknown command ${command}; expected serve, devices or forget`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
