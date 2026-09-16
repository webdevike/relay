#!/usr/bin/env bun
// relay-linux: the Linux host daemon. `serve` (default) advertises the host, prints pairing
// PINs to this terminal, and injects phone input through /dev/uinput. `devices` / `forget`
// manage paired phones. `share` hands text, a URL or a file to the running daemon's drop box
// over its loopback HTTP endpoint; `serve` leaves its port in `relay/serve.json` so `share`
// can find it.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Drop } from "@relay/protocol";
import { z } from "zod";
import pkg from "../package.json";
import { defaultSocketPath, OmpBridgeProvider } from "./agents/bridge";
import { FileDeviceStore } from "./device-store";
import { FileDropStore } from "./drops/store";
import { detectTextTyper, KeyboardInjector } from "./input/keyboard";
import { ClipboardPaster, systemCopy } from "./input/paste";
import type { EventPoster } from "./input/poster";
import { TrackpadInputSink } from "./input/trackpad";
import { UinputDevice } from "./input/uinput";
import { AvahiAdvertiser } from "./mdns";
import { TerminalPairingUI } from "./pairing";
import { ExpoPushSender } from "./push/expo";
import { AttentionNotifier } from "./push/notifier";
import { FilePushTokenStore } from "./push/token-store";
import { RelayServer } from "./server";
import { systemClock } from "./session";
import { ClipboardWatcher, systemPaste, systemWatch } from "./drops/clipboard";

const USAGE = `relay-linux <command>

  serve [--port N] [--name NAME] [--agent-home DIR] [--no-clipboard]
                                   run the host (default command); --agent-home is where a
                                   session started from the phone opens (default: $HOME);
                                   --no-clipboard stops desktop copies from becoming drops
  devices                          list paired phones
  forget <deviceId>                remove a paired phone
  share <text | url | path> ...    add to the drop box of the running host: one existing file
                                   goes as a file, anything else as text; \`share -\` or no
                                   arguments reads stdin

Input goes through /dev/uinput: your user needs read/write on it (e.g. membership in the
\`input\` group, then log out and back in).`;

const ServeInfo = z.object({ port: z.number().int().min(1).max(65535), pid: z.number().int() });

function serveInfoPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "serve.json");
}

/**
 * Stands in while /dev/uinput is unavailable. Never reached: the session refuses input and
 * commands while `access.granted` is false, so any call here is a wiring bug.
 */
const NO_INPUT: EventPoster = {
  moveBy: unavailable,
  button: unavailable,
  scroll: unavailable,
  tapKey: unavailable,
};

function unavailable(): never {
  throw new Error("virtual input device unavailable");
}

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${line}`);
}

function serve(
  port: number,
  name: string,
  agentHome: string | null,
  watchClipboard: boolean,
): void {
  let device: UinputDevice | null = null;
  try {
    device = new UinputDevice();
    log("virtual input device created");
  } catch (error) {
    console.error(`input unavailable: ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "the phone will connect but pointer/keyboard commands will be refused until this is fixed",
    );
  }
  const poster = device ?? NO_INPUT;
  const typer = detectTextTyper();
  log(
    typer === null
      ? "text input: uinput US layout (ASCII only; install wtype on Wayland for Unicode)"
      : "text input: wtype",
  );

  const agents = new OmpBridgeProvider(defaultSocketPath(), log, agentHome);
  const pushTokens = new FilePushTokenStore();
  const drops = new FileDropStore();
  // `isViewing` only runs once sessions change, long after `server` below is initialised.
  const notifier = new AttentionNotifier({
    tokens: pushTokens,
    sender: new ExpoPushSender(),
    isViewing: (deviceId, sessionId): boolean => server.isViewing(deviceId, sessionId),
    clock: systemClock,
    log,
  });
  const clipboard =
    watchClipboard && Bun.which("wl-paste") !== null
      ? new ClipboardWatcher({
          drops,
          paste: systemPaste,
          watch: systemWatch,
          log,
          after: (ms, fn) => systemClock.after(ms, fn),
        })
      : null;
  const images = new ClipboardPaster({
    poster,
    copy: systemCopy,
    expect:
      clipboard === null
        ? null
        : (mimeType, bytes) => {
            clipboard.expect(mimeType, bytes);
          },
  });
  const server: RelayServer = new RelayServer(
    { port, hostName: name, version: pkg.version },
    {
      input: new TrackpadInputSink(poster),
      text: new KeyboardInjector(poster, typer),
      access: { granted: device !== null },
      images,
      agents,
      devices: new FileDeviceStore(),
      push: pushTokens,
      drops,
      notifier,
      pairing: new TerminalPairingUI(),
      log,
    },
  );
  const boundPort = server.start();
  const infoPath = serveInfoPath();
  mkdirSync(dirname(infoPath), { recursive: true, mode: 0o700 });
  writeFileSync(infoPath, JSON.stringify({ port: boundPort, pid: process.pid }), { mode: 0o600 });
  chmodSync(infoPath, 0o600);
  log(`listening on ws://0.0.0.0:${boundPort}/relay as "${name}"`);
  log(
    `agent bridge listening on ${defaultSocketPath()} (omp sessions register via omp-extension/relay-bridge.ts)`,
  );
  log(
    agentHome === null
      ? "agent.start disabled (no --agent-home and no $HOME)"
      : `agent.start opens omp in ${agentHome}`,
  );

  const advertiser = new AvahiAdvertiser(name, boundPort, log);
  advertiser.start();
  log("advertising _relay._tcp via avahi");

  clipboard?.start();
  log(
    clipboard === null
      ? watchClipboard
        ? "clipboard watcher disabled (wl-paste not found)"
        : "clipboard watcher disabled (--no-clipboard)"
      : "clipboard watcher: every copy becomes a drop",
  );

  const shutdown = (): void => {
    log("shutting down");
    clipboard?.stop();
    rmSync(infoPath, { force: true });
    advertiser.stop();
    server.stop();
    device?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** `share` body: one existing file goes as a blob, anything else (or stdin) as text. */
async function share(positionals: string[]): Promise<void> {
  let info: z.infer<typeof ServeInfo>;
  try {
    info = ServeInfo.parse(JSON.parse(readFileSync(serveInfoPath(), "utf8")));
  } catch {
    throw new Error("relay-linux serve is not running");
  }
  const url = `http://127.0.0.1:${info.port}/drops`;
  let response: Response;
  const single = positionals.length === 1 ? positionals[0] : undefined;
  if (single !== undefined && single !== "-" && isFile(single)) {
    const file = Bun.file(single);
    // A text/plain type would make the server store the body as a text drop; files always go as blobs.
    const type = file.type.startsWith("text/plain") ? "application/octet-stream" : file.type;
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": type, "x-drop-name": basename(single) },
      body: await file.bytes(),
    });
  } else {
    const text =
      positionals.length === 0 || single === "-" ? await Bun.stdin.text() : positionals.join(" ");
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: text,
    });
  }
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const drop = Drop.parse(await response.json());
  console.log(`shared ${drop.kind} ${drop.id}`);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "0" },
      name: { type: "string", default: hostname() },
      "agent-home": { type: "string" },
      "no-clipboard": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "serve": {
      const port = Number.parseInt(values.port, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error(`invalid --port ${values.port}`);
      serve(
        port,
        values.name,
        values["agent-home"] ?? process.env["HOME"] ?? null,
        !values["no-clipboard"],
      );
      return;
    }
    case "devices": {
      const devices = new FileDeviceStore().pairedDevices();
      if (devices.length === 0) {
        console.log("no paired devices");
        return;
      }
      for (const device of devices) {
        console.log(
          `${device.id}  ${device.name}  paired ${new Date(device.pairedAt).toISOString()}`,
        );
      }
      return;
    }
    case "forget": {
      const id = positionals[1];
      if (id === undefined) throw new Error("forget: missing deviceId");
      new FileDeviceStore().forget(id);
      new FilePushTokenStore().unregister(id);
      console.log(`forgot ${id}`);
      return;
    }
    case "share":
      await share(positionals.slice(1));
      return;
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
