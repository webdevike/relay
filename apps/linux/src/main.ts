#!/usr/bin/env bun
// relay-linux: the Linux host daemon. `serve` (default) advertises the host, prints pairing
// PINs to this terminal, and injects phone input through /dev/uinput. `devices` / `forget`
// manage paired phones.

import { hostname } from "node:os";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { defaultSocketPath, OmpBridgeProvider } from "./agents/bridge";
import { FileDeviceStore } from "./device-store";
import { detectTextTyper, KeyboardInjector } from "./input/keyboard";
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

const USAGE = `relay-linux <command>

  serve [--port N] [--name NAME] [--agent-home DIR]
                                   run the host (default command); --agent-home is where a
                                   session started from the phone opens (default: $HOME)
  devices                          list paired phones
  forget <deviceId>                remove a paired phone

Input goes through /dev/uinput: your user needs read/write on it (e.g. membership in the
\`input\` group, then log out and back in).`;
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

function serve(port: number, name: string, agentHome: string | null): void {
  let device: UinputDevice | null = null;
  try {
    device = new UinputDevice();
    log("virtual input device created");
  } catch (error) {
    console.error(`input unavailable: ${error instanceof Error ? error.message : String(error)}`);
    console.error("the phone will connect but pointer/keyboard commands will be refused until this is fixed");
  }
  const poster = device ?? NO_INPUT;
  const typer = detectTextTyper();
  log(typer === null ? "text input: uinput US layout (ASCII only; install wtype on Wayland for Unicode)" : "text input: wtype");

  const agents = new OmpBridgeProvider(defaultSocketPath(), log, agentHome);
  const pushTokens = new FilePushTokenStore();
  // `isViewing` only runs once sessions change, long after `server` below is initialised.
  const notifier = new AttentionNotifier({
    tokens: pushTokens,
    sender: new ExpoPushSender(),
    isViewing: (deviceId, sessionId): boolean => server.isViewing(deviceId, sessionId),
    clock: systemClock,
    log,
  });
  const server: RelayServer = new RelayServer(
    { port, hostName: name, version: pkg.version },
    {
      input: new TrackpadInputSink(poster),
      text: new KeyboardInjector(poster, typer),
      access: { granted: device !== null },
      agents,
      devices: new FileDeviceStore(),
      push: pushTokens,
      notifier,
      pairing: new TerminalPairingUI(),
      log,
    },
  );
  const boundPort = server.start();
  log(`listening on ws://0.0.0.0:${boundPort}/relay as "${name}"`);
  log(`agent bridge listening on ${defaultSocketPath()} (omp sessions register via omp-extension/relay-bridge.ts)`);
  log(agentHome === null ? "agent.start disabled (no --agent-home and no $HOME)" : `agent.start opens omp in ${agentHome}`);

  const advertiser = new AvahiAdvertiser(name, boundPort, log);
  advertiser.start();
  log("advertising _relay._tcp via avahi");

  const shutdown = (): void => {
    log("shutting down");
    advertiser.stop();
    server.stop();
    device?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: "string", default: "0" },
      name: { type: "string", default: hostname() },
      "agent-home": { type: "string" },
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
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port ${values.port}`);
      serve(port, values.name, values["agent-home"] ?? process.env["HOME"] ?? null);
      return;
    }
    case "devices": {
      const devices = new FileDeviceStore().pairedDevices();
      if (devices.length === 0) {
        console.log("no paired devices");
        return;
      }
      for (const device of devices) {
        console.log(`${device.id}  ${device.name}  paired ${new Date(device.pairedAt).toISOString()}`);
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
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
