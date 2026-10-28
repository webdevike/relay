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
import { Drop, sessionReactionThread } from "@relay/protocol";
import { z } from "zod";
import pkg from "../package.json";
import { defaultSocketPath, OmpBridgeProvider } from "./agents/bridge";
import { type AssistantAgentConfig, loadRegistry, REGISTRY_FILE } from "./assistant/registry";
import { AssistantService, AssistantThreads, type AssistantThreadsDeps } from "./assistant/service";
import { spawnFill } from "./assistant/signin";
import { defaultAssistantPath, FileAssistantStore } from "./assistant/store";
import { CallService } from "./call/service";
import { EvaRealtimeVoice } from "./call/voice";
import { FileDeviceStore } from "./device-store";
import { FileDropStore } from "./drops/store";
import { ffmpegProbe, isVideoMime, maxVideoBytesFromEnv, videoMimeOf, VideoTooLarge } from "./drops/video";
import { FileBoardStore } from "./boards/store";
import { createUsageService, ompUsageRunner } from "./usage/service";
import { CatchUpService, defaultCatchUpFeedPath, defaultCatchUpNotesPath, defaultCatchUpStatePath } from "./catchup/service";
import { defaultReactionsPath, reactionFeedbackPath, ReactionService } from "./reactions/service";
import { ArtifactService, defaultArtifactsRoot } from "./artifacts/service";
import { detectTextTyper, KeyboardInjector } from "./input/keyboard";
import { MacInputDevice } from "./input/macos";
import { ClipboardPaster, systemCopy } from "./input/paste";
import type { EventPoster } from "./input/poster";
import { TrackpadInputSink } from "./input/trackpad";
import { UinputDevice } from "./input/uinput";
import { BonjourAdvertiser } from "./mdns";
import { TerminalPairingUI } from "./pairing";
import { ExpoPushSender } from "./push/expo";
import { InboxService } from "./inbox/service";
import { AttentionNotifier } from "./push/notifier";
import { FilePushTokenStore } from "./push/token-store";
import { RelayServer } from "./server";
import { DEFAULT_VNC_PORT } from "./vnc";
import { systemClock } from "./session";
import { ClipboardWatcher, systemPaste, systemWatch } from "./drops/clipboard";

const USAGE = `relay-linux <command>

  serve [--port N] [--name NAME] [--agent-home DIR] [--no-clipboard] [--boards DIR] [--vnc-port N]
                                   run the host (default command); --agent-home is where a
                                   session started from the phone opens (default: $HOME);
                                   --no-clipboard stops desktop copies from becoming drops;
                                   --boards (or $RELAY_BOARDS_DIR) stores live dashboards
                                   there (default: boards disabled). Calls to the assistants use
                                   eva-realtime's speech workers ($RELAY_VOICE_ROOT, default
                                   <agent-home>/apps/eva-realtime) and pocket-tts on
                                   $POCKET_PORT (8853) in voice $POCKET_VOICE (stuart_bell).
                                   The live view bridges paired phones to the Mac's Screen
                                   Sharing (VNC) on 127.0.0.1, port --vnc-port (default ${String(DEFAULT_VNC_PORT)})
  devices                          list paired phones
  forget <deviceId>                remove a paired phone
  share <text | url | path> ...    add to the drop box of the running host: one existing file
                                   goes as a file, anything else as text; \`share -\` or no
                                   arguments reads stdin. A video (mp4/webm/mov) is capped at
                                   25 MB ($RELAY_MAX_VIDEO_MB on the host) and gets a poster;
                                   blobs also print a ready-to-paste markdown embed
  board list                       list the running host's dashboards
  board get <slug>                 print one dashboard
  board put <slug> [< json]        create/replace from {title, workspace?, icon?, widgets?}
  board ops <slug> [< json]        apply a BoardOp[] array, all or nothing
  board rm <slug>                  delete a dashboard
  assistant say --agent <id> <text> ...
                                   hand assistant thread <id> (from <agent-home>/${REGISTRY_FILE})
                                   of the running host a message from a background job; it
                                   relays it to Isaac. \`say -\` or no text reads stdin

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
  boardsDir: string | null,
  vncPort: number,
): void {
  let device: UinputDevice | MacInputDevice | null = null;
  try {
    device = process.platform === "darwin" ? new MacInputDevice() : new UinputDevice();
    if (device instanceof MacInputDevice) {
      log(`macOS input: Accessibility ${device.granted ? "granted" : "required"}`);
      if (!device.granted) device.requestAccess();
    } else {
      log("virtual input device created");
    }
  } catch (error) {
    console.error(`input unavailable: ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "the phone will connect but pointer/keyboard commands will be refused until this is fixed",
    );
  }
  const poster = device ?? NO_INPUT;
  const typer = device instanceof MacInputDevice ? device.typeText.bind(device) : detectTextTyper();
  log(device instanceof MacInputDevice ? "text input: macOS Unicode" : typer === null
    ? "text input: uinput US layout (ASCII only; install wtype on Wayland for Unicode)"
    : "text input: wtype");

  const agents = new OmpBridgeProvider(defaultSocketPath(), log, agentHome);
  const pushTokens = new FilePushTokenStore();
  const drops = new FileDropStore(undefined, { maxVideoBytes: maxVideoBytesFromEnv(), probe: ffmpegProbe(log) });
  const boards = boardsDir === null ? null : new FileBoardStore(boardsDir, log);
  // Snapshots only flow once a phone asks (`usage.get`), long after `server` below is initialised.
  const usage = createUsageService({
    profilesDir: join(homedir(), ".omp", "profiles"),
    run: ompUsageRunner(),
    emit: (snapshot) => {
      server.broadcastExcept({ t: "usage.snapshot", usage: snapshot }, null);
    },
  });
  // Snapshots go out on feed or state changes, and handoffs reach the assistant threads, long after
  // `server` and `assistant` below are initialised.
  const catchupFeed = defaultCatchUpFeedPath(agentHome);
  const catchup =
    catchupFeed === null
      ? null
      : new CatchUpService({
          feedPath: catchupFeed,
          statePath: defaultCatchUpStatePath(),
          notesPath: defaultCatchUpNotesPath(agentHome),
          emit: (snapshot) => {
            server.broadcastExcept({ t: "catchup.snapshot", ...snapshot }, null);
          },
          // A handoff is Isaac's turn in that assistant's thread, as if he had typed it there.
          deliver: async (agent, text) => {
            const thread = assistant?.thread(agent);
            if (thread === undefined) throw new Error(`no assistant thread ${agent}`);
            await thread.turn(text);
          },
          knows: (agent) => assistant?.threads.some((thread) => thread.id === agent) ?? false,
          log,
        });
  // `isViewing` only runs once sessions change, long after `server` below is initialised.
  const notifier = new AttentionNotifier({
    tokens: pushTokens,
    sender: new ExpoPushSender(),
    isViewing: (deviceId, sessionId): boolean => server.isViewing(deviceId, sessionId),
    suppressed: (): boolean => server.escalatorConnected(),
    clock: systemClock,
    log,
  });
  const inbox = new InboxService({
    tokens: pushTokens,
    sender: new ExpoPushSender(),
    broadcast: (message, exceptDeviceId): void => {
      server.broadcastExcept(message, exceptDeviceId);
    },
    isViewing: (deviceId, sessionId): boolean => server.isViewing(deviceId, sessionId),
    log,
  });
  const assistant = assistantThreads(agentHome, (agent) => new AssistantService({
    agent,
    agents,
    launch: (options) => agents.launchWith(options),
    sessionFile: (sessionId) => agents.sessionFile(sessionId),
    agentHome,
    store: new FileAssistantStore(defaultAssistantPath(agent.id)),
    tokens: pushTokens,
    sender: new ExpoPushSender(),
    broadcast: (message): void => {
      server.broadcastAssistant(agent.id, message);
    },
    isViewing: (deviceId): boolean => server.isViewingAssistant(deviceId, agent.id),
    clock: systemClock,
    log,
    spawn: spawnFill,
  }), {
    // The phones' agent list follows status and last-reply changes on its own, without waiting for a request.
    broadcast: (message): void => {
      server.broadcastExcept(message, null);
    },
    clock: systemClock,
    log,
  });
  const voice =
    assistant === null || agentHome === null
      ? null
      : new EvaRealtimeVoice({
          root: process.env["RELAY_VOICE_ROOT"] ?? join(agentHome, "apps", "eva-realtime"),
          ttsUrl: `http://127.0.0.1:${process.env["POCKET_PORT"] ?? "8853"}`,
          defaultVoice: process.env["POCKET_VOICE"] ?? "stuart_bell",
          log,
        });
  const calls =
    assistant === null || voice === null
      ? null
      : new CallService({
          thread: (id) => {
            const thread = assistant.threads.find((candidate) => candidate.id === id);
            if (thread === undefined) return undefined;
            return {
              id: thread.id,
              title: thread.title,
              ...(thread.voice === undefined ? {} : { voice: thread.voice }),
              session: () => thread.current(),
              turn: (text) => thread.turn(text),
            };
          },
          voice,
          clock: systemClock,
          log,
        });
  // Reaches the devices and the threads' sessions long after `server` and `assistant` are initialised.
  const reactions = new ReactionService({
    path: defaultReactionsPath(),
    feedbackPath: (agent) => reactionFeedbackPath(agentHome, agent),
    broadcast: (message): void => {
      server.broadcastExcept(message, null);
    },
    session: (thread) => {
      if (thread.startsWith("assistant:")) return assistant?.thread(thread.slice("assistant:".length))?.current()?.id ?? null;
      const id = thread.slice("session:".length);
      return agents.sessions.some((session) => session.id === id && session.status !== "ended") ? id : null;
    },
    note: (sessionId, text) => agents.note(sessionId, text),
    clock: systemClock,
    log,
  });
  const repos = new Map<string, string | null>();
  const artifacts = new ArtifactService({
    root: defaultArtifactsRoot(),
    evaRoot: agentHome,
    broadcast: (message): void => {
      server.broadcastExcept(message, null);
    },
    threadFiles: (thread) => {
      if (thread.startsWith("session:")) {
        const file = agents.sessionFile(thread.slice("session:".length));
        return file === null ? [] : [file];
      }
      const agent = thread.slice("assistant:".length);
      const record = assistant?.threads.some((candidate) => candidate.id === agent) === true ? new FileAssistantStore(defaultAssistantPath(agent)).load() : null;
      const live = assistant?.thread(agent)?.current();
      const liveFile = live === undefined ? null : agents.sessionFile(live.id);
      const files = [...(record?.history ?? []), ...(record?.sessionFile === undefined ? [] : [record.sessionFile]), ...(liveFile === null ? [] : [liveFile])];
      return [...new Set(files)];
    },
    threadOf: (sessionId) => {
      const session = agents.sessions.find((candidate) => candidate.id === sessionId);
      return session === undefined ? null : sessionReactionThread(session);
    },
    drop: (id) => drops.list().find((drop) => drop.id === id),
    repoOf: (cwd) => {
      const known = repos.get(cwd);
      if (known !== undefined) return known;
      const out = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
      const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(out.stdout.toString().trim());
      const repo = out.exitCode === 0 ? (match?.[1] ?? null) : null;
      repos.set(cwd, repo);
      return repo;
    },
    clock: systemClock,
    log,
  });
  artifacts.loadAll();
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
  log(`live view: VNC bridge to 127.0.0.1:${String(vncPort)} (macOS Screen Sharing)`);
  const server: RelayServer = new RelayServer(
    { port, hostName: name, version: pkg.version, vncPort },
    {
      input: new TrackpadInputSink(poster),
      text: new KeyboardInjector(poster, typer),
      access: { get granted() { return device instanceof MacInputDevice ? device.granted : device !== null; } },
      images,
      agents,
      devices: new FileDeviceStore(),
      push: pushTokens,
      drops,
      boards,
      notifier,
      inbox,
      assistant,
      calls,
      usage,
      catchup,
      reactions,
      artifacts,
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
  log(boardsDir === null ? "boards disabled (no --boards or $RELAY_BOARDS_DIR)" : `boards stored in ${boardsDir}`);

  const advertiser = new BonjourAdvertiser(name, boundPort, log);
  advertiser.start();
  log(`advertising _relay._tcp via ${advertiser.tool}`);

  clipboard?.start();
  catchup?.start();
  log(catchupFeed === null ? "catch up disabled (no --agent-home or $RELAY_CATCHUP_FEED)" : `catch up feed ${catchupFeed}`);
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
    voice?.stop();
    catchup?.stop();
    device?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * One thread per agent in `<agentHome>/.omp/assistant/agents.json`, read once at start; null (and
 * logged) when there is no agent home or the registry is missing or invalid.
 */
function assistantThreads(
  agentHome: string | null,
  create: (agent: AssistantAgentConfig) => AssistantService,
  deps: AssistantThreadsDeps,
): AssistantThreads | null {
  if (agentHome === null) {
    log("assistant threads disabled (no --agent-home)");
    return null;
  }
  let registry: readonly AssistantAgentConfig[];
  try {
    registry = loadRegistry(agentHome);
  } catch (error) {
    log(`assistant threads disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  log(`assistant threads: ${registry.map((agent) => `${agent.title} (${agent.id})`).join(", ")}`);
  return new AssistantThreads(registry.map(create), deps);
}

/** The running host's loopback base URL, from the port `serve` left in serve.json. */
function hostUrl(): string {
  let info: z.infer<typeof ServeInfo>;
  try {
    info = ServeInfo.parse(JSON.parse(readFileSync(serveInfoPath(), "utf8")));
  } catch {
    throw new Error("relay-linux serve is not running");
  }
  return `http://127.0.0.1:${info.port}`;
}

/** `share` body: one existing file goes as a blob, anything else (or stdin) as text. */
async function share(positionals: string[]): Promise<void> {
  const url = `${hostUrl()}/drops`;
  let response: Response;
  const single = positionals.length === 1 ? positionals[0] : undefined;
  if (single !== undefined && single !== "-" && isFile(single)) {
    const file = Bun.file(single);
    // A text/plain type would make the server store the body as a text drop; files always go as blobs.
    const type = file.type.startsWith("text/plain") ? "application/octet-stream" : file.type;
    // The host would refuse these anyway (413, or a dropped connection past its body limit); say
    // why without uploading. The host's own $RELAY_MAX_VIDEO_MB still decides what it accepts.
    const name = basename(single);
    const maxVideo = maxVideoBytesFromEnv();
    if (isVideoMime(videoMimeOf(name, type)) && file.size > maxVideo) {
      console.error(new VideoTooLarge(name, file.size, maxVideo).message);
      process.exit(1);
    }
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": type, "x-drop-name": name },
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
  if (drop.file === undefined) {
    console.log(`shared ${drop.kind} ${drop.id}`);
    return;
  }
  // Blob drops also print their fetch path so an agent can reference it (e.g. a ```ui compare
  // widget), then the markdown that shows it inline: the phone plays a video embedded this way.
  const video = isVideoMime(drop.file.mimeType);
  console.log(`shared ${video ? "video" : drop.kind} ${drop.id} ${drop.file.path}`);
  const { durationMs, width, height, poster } = drop.file;
  if (video) {
    const facts = [
      durationMs === undefined ? null : `${(durationMs / 1000).toFixed(1)}s`,
      width === undefined || height === undefined ? null : `${String(width)}x${String(height)}`,
      `${(drop.file.size / (1024 * 1024)).toFixed(1)} MB`,
      poster === undefined ? "no poster (ffmpeg missing on the host)" : `poster ${poster}`,
    ];
    console.log(`video ${facts.filter((fact) => fact !== null).join(" · ")}`);
  }
  const caption = drop.file.name.replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
  console.log(`embed ![${caption}](${drop.file.path})`);
}

/** `assistant say --agent <id> <text>`: the running host hands the text to agent `id` as a turn from the host's jobs. */
async function assistantSay(agent: string | undefined, positionals: string[]): Promise<void> {
  if (agent === undefined || agent === "") throw new Error("assistant say: missing --agent <id>");
  const text = positionals.length === 0 || positionals[0] === "-" ? await Bun.stdin.text() : positionals.join(" ");
  const response = await fetch(`${hostUrl()}/assistant/say?agent=${encodeURIComponent(agent)}`, {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: text,
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  console.log(`told ${agent}`);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `board <list|get|put|ops|rm>`: prints the host's JSON reply; exits 1 with its error otherwise. */
async function board(positionals: string[]): Promise<void> {
  const [action, slug] = positionals;
  const base = `${hostUrl()}/boards`;
  const target = (): string => {
    if (slug === undefined) throw new Error(`board ${action ?? ""}: missing <slug>`);
    return `${base}/${encodeURIComponent(slug)}`;
  };
  let response: Response;
  switch (action ?? "") {
    case "list":
      response = await fetch(base);
      break;
    case "get":
      response = await fetch(target());
      break;
    case "put":
      response = await fetch(target(), { method: "PUT", headers: { "content-type": "application/json" }, body: await Bun.stdin.text() });
      break;
    case "ops":
      response = await fetch(`${target()}/ops`, { method: "POST", headers: { "content-type": "application/json" }, body: await Bun.stdin.text() });
      break;
    case "rm":
      response = await fetch(target(), { method: "DELETE", headers: { "content-type": "application/json" } });
      break;
    default:
      throw new Error(`board: expected list, get, put, ops or rm\n\n${USAGE}`);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = z.object({ error: z.string() }).parse(JSON.parse(text)).error;
    } catch {
      // not a JSON error body; print it as is
    }
    console.error(`board ${action}: ${response.status} ${message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(JSON.parse(text), null, 2));
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
      boards: { type: "string" },
      "vnc-port": { type: "string", default: String(DEFAULT_VNC_PORT) },
      agent: { type: "string" },
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
      const vncPort = Number.parseInt(values["vnc-port"], 10);
      if (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535)
        throw new Error(`invalid --vnc-port ${values["vnc-port"]}`);
      serve(
        port,
        values.name,
        values["agent-home"] ?? process.env["HOME"] ?? null,
        !values["no-clipboard"],
        values.boards ?? process.env["RELAY_BOARDS_DIR"] ?? null,
        vncPort,
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
    case "board":
      await board(positionals.slice(1));
      return;
    case "assistant": {
      const verb = positionals[1];
      if (verb !== "say") throw new Error(`assistant: unknown subcommand ${verb ?? "(none)"}; try \`assistant say --agent <id> <text>\``);
      await assistantSay(values.agent, positionals.slice(2));
      return;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
