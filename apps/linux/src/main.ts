#!/usr/bin/env bun
// relay-linux: the Linux host daemon. `serve` (default) advertises the host, prints pairing
// PINs to this terminal, and injects phone input through /dev/uinput. `devices` / `forget`
// manage paired phones. `share` hands text, a URL or a file to the running daemon's drop box
// over its loopback HTTP endpoint; `serve` leaves its port in `relay/serve.json` so `share`
// can find it.

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Drop, sessionReactionThread } from "@relay/protocol";
import { z } from "zod";
import pkg from "../package.json";
import { defaultSocketPath, OmpBridgeProvider } from "./agents/bridge";
import { SessionFiles } from "./agents/session-files";
import { type AssistantAgentConfig, liveVoiceFor, loadRegistry, REGISTRY_FILE } from "./assistant/registry";
import { AssistantService, AssistantThreads, type AssistantThreadsDeps } from "./assistant/service";
import { spawnFill } from "./assistant/signin";
import { defaultAssistantPath, FileAssistantStore } from "./assistant/store";
import { CallService } from "./call/service";
import { EvaRealtimeVoice } from "./call/voice";
import { openAiKey, OpenAiLive } from "./live/openai";
import { LiveService } from "./live/service";
import { FileDeviceStore } from "./device-store";
import { FileDropStore } from "./drops/store";
import { ffmpegProbe, isVideoMime, maxVideoBytesFromEnv, videoMimeOf, VideoTooLarge } from "./drops/video";
import { FileBoardStore } from "./boards/store";
import { createUsageService, ompUsageRunner } from "./usage/service";
import { CatchUpService, defaultCatchUpFeedPath, defaultCatchUpNotesPath, defaultCatchUpStatePath } from "./catchup/service";
import { defaultReactionsPath, reactionFeedbackPath, ReactionService } from "./reactions/service";
import { ArtifactService, defaultArtifactsRoot } from "./artifacts/service";
import { brainConfigOverlay, ompBrains, resolveOmp } from "./canvas/brain";
import { detectCaller, systemCallerDeps } from "./canvas/caller";
import { CANVAS_PAGE } from "./canvas/page";
import { CanvasService } from "./canvas/service";
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
import { CodexRunner, ompCodexToken } from "./studio/codex";
import { HiggsfieldRunner, ompHiggsfieldCredentials } from "./studio/higgsfield";
import { LtxRunner } from "./studio/ltx";
import { ffmpegMedia } from "./studio/media";
import { StudioService, type StudioMessage } from "./studio/service";
import { defaultStudioDir } from "./studio/store";

const USAGE = `relay-linux <command>

  serve [--port N] [--name NAME] [--agent-home DIR] [--no-clipboard] [--boards DIR] [--vnc-port N]
        [--canvases DIR]
                                   run the host (default command); --agent-home is where a
                                   session started from the phone opens (default: $HOME);
                                   --no-clipboard stops desktop copies from becoming drops;
                                   --boards (or $RELAY_BOARDS_DIR) stores live dashboards
                                   there (default: boards disabled). Calls to the assistants use
                                   eva-realtime's speech workers ($RELAY_VOICE_ROOT, default
                                   <agent-home>/apps/eva-realtime) and pocket-tts on
                                   $POCKET_PORT (8853) in voice $POCKET_VOICE (stuart_bell).
                                   GPT-Live calls (phone WebRTC <-> OpenAI, the assistant as
                                   the brain) use $OPENAI_API_KEY or <agent-home>/secrets/
                                   openai.env, in the agent's registry liveVoice, else $RELAY_LIVE_VOICE (marin); without a
                                   key the phone falls back to the local call.
                                   The live view bridges paired phones to the Mac's Screen
                                   Sharing (VNC) on 127.0.0.1, port --vnc-port (default ${String(DEFAULT_VNC_PORT)}).
                                   Live canvas rooms run on the EvaOS boards in --canvases
                                   (default on macOS: ~/Library/Application Support/EvaOS/canvases;
                                   elsewhere off) with omp from PATH or $RELAY_CANVAS_OMP.
                                   Studio keeps jobs in $XDG_CONFIG_HOME/relay/studio; local
                                   video runs <agent-home>/work/local-video/draft.py
                                   ($RELAY_STUDIO_LTX_DIR), Codex images and Higgsfield use
                                   omp's personal sign-ins
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
  canvas start [<slug>] [--title "New board"] [--prompt "what this session is for"]
                                   from an omp session: start a live canvas on board <slug> (an
                                   EvaOS board; a new one when it does not exist or no slug is
                                   given). Isaac gets a Join card in this chat; the canvas agent
                                   is this chat's assistant (Nova in Nova's thread, else Eva) with
                                   the chat as context, and posts each turn and the wrap-up here
  canvas join <slug> --as <Name> [--prompt "what I am here to do"] [--color "#rrggbb"]
                                   join a live room as an agent of your own (any omp session, a
                                   subagent too): your own cursor, name, color and portrait
  canvas act <slug> --as <Name> [<lines> | -]
                                   run action lines as <Name> (joins first when needed): @say,
                                   @add_node, @add_image, @add_frame, @add_edge, @set_text,
                                   @append_text, @move_node, @point, @select, @cursor, @delete
                                   (skill://canvas section 8); no lines or - reads stdin
  canvas show <slug>               the live room's board, who is in it, and the latest chat (JSON)
  canvas leave <slug> --as <Name>  take <Name>'s cursor out of the room
  canvas list                      list the running host's canvas rooms
  canvas end [<slug>]              wrap up the live session on <slug> (default: this chat's)
  react <emoji> [--agent <id>] [--message latest|<key>]
  react --clear [--agent <id>] [--message latest|<key>]
                                   from an assistant's session: react to (or take back the
                                   reaction on) Isaac's newest message in its thread, or bubble
                                   <key> (\`user@<ms>\`); --agent defaults to $RELAY_ASSISTANT.
                                   Shown on his devices; never a turn or a push

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
  canvasDir: string | null,
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
  const liveKey = assistant === null ? null : openAiKey(agentHome);
  const live =
    assistant === null
      ? null
      : new LiveService({
          thread: (id) => {
            const thread = assistant.threads.find((candidate) => candidate.id === id);
            if (thread === undefined) return undefined;
            return {
              id: thread.id,
              title: thread.title,
              session: () => thread.current(),
              turn: (text) => thread.turn(text),
              rows: async () => (await thread.snapshot()).messages,
            };
          },
          api: liveKey === null ? null : new OpenAiLive(liveKey),
          voice: (agent) => liveVoiceFor(assistant.threads, agent, process.env["RELAY_LIVE_VOICE"]),
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
  const canvas = liveCanvas(canvasDir, agentHome, agents);
  // Jobs and state go out long after `server` below is initialised.
  const studio = studioService(agentHome, (message) => {
    server.broadcastExcept(message, null);
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
      live,
      usage,
      catchup,
      reactions,
      artifacts,
      canvas,
      sessionFiles: new SessionFiles(),
      studio,
      canvasPage: () => CANVAS_PAGE,
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
  studio?.start();
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
    canvas?.stop();
    studio?.stop();
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
 * Live canvas rooms on the boards in `canvasDir`, their agents' brains a warm omp each; null (and
 * logged) without a canvases dir or an omp binary.
 */
function liveCanvas(canvasDir: string | null, agentHome: string | null, agents: OmpBridgeProvider): CanvasService | null {
  if (canvasDir === null) {
    log("live canvas disabled (no --canvases)");
    return null;
  }
  const omp = resolveOmp();
  if (omp === null) {
    log("live canvas disabled: omp not found (set $RELAY_CANVAS_OMP)");
    return null;
  }
  let registry: readonly AssistantAgentConfig[] = [];
  try {
    if (agentHome !== null) registry = loadRegistry(agentHome);
  } catch {
    // Without a registry every chat's agent is Eva.
  }
  const configDir = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "relay");
  log(`live canvas on boards in ${canvasDir} (brains: ${omp})`);
  return new CanvasService({
    canvasDir,
    chats: agents,
    registry,
    avatarsDir: agentHome === null ? null : join(agentHome, "work", "assistant-avatars"),
    brains: ompBrains({ omp, profile: "personal", configs: [brainConfigOverlay(configDir)], log }),
    log,
  });
}

/**
 * Studio in `$XDG_CONFIG_HOME/relay/studio`: local LTX video from `<agent-home>/work/local-video`
 * (`$RELAY_STUDIO_LTX_DIR`), Codex images on omp's personal ChatGPT sign-in, Higgsfield on omp's
 * personal Higgsfield sign-in. Null (and logged) when its index can't be read.
 */
function studioService(agentHome: string | null, emit: (message: StudioMessage) => void): StudioService | null {
  const media = ffmpegMedia(log);
  const token = ompCodexToken(resolveOmp());
  const ltxDir = process.env["RELAY_STUDIO_LTX_DIR"] ?? join(agentHome ?? join(homedir(), "Eva"), "work", "local-video");
  try {
    const studio = new StudioService({
      dir: defaultStudioDir(),
      runners: {
        ltx: new LtxRunner(ltxDir),
        "codex-image": new CodexRunner({ backend: "codex-image", token, fetch, jpeg: media.jpeg, cover: media.cover }),
        "codex-edit": new CodexRunner({ backend: "codex-edit", token, fetch, jpeg: media.jpeg, cover: media.cover }),
        higgsfield: new HiggsfieldRunner({
          credentials: ompHiggsfieldCredentials(join(homedir(), ".omp", "profiles", "personal", "agent", "agent.db")),
          fetch,
          now: Date.now,
          sleep: (ms, signal) => delay(ms, undefined, { signal }),
        }),
      },
      media,
      emit,
      clock: systemClock,
      log,
    });
    log(`studio in ${defaultStudioDir()}, local video from ${ltxDir}`);
    return studio;
  } catch (error) {
    log(`studio disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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

/** The host's JSON answer, or exit 1 with its `{error}` (or body). */
async function hostJson(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = z.object({ error: z.string() }).parse(JSON.parse(text)).error;
    } catch {
      // not a JSON error body; print it as is
    }
    console.error(`${what}: ${message}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

const CanvasRoomsReply = z.object({ rooms: z.array(z.object({ id: z.string(), slug: z.string(), board: z.string(), live: z.boolean(), agent: z.object({ name: z.string() }), chat: z.object({ sessionId: z.string().optional(), title: z.string().optional() }), humans: z.array(z.string()) })) });
const CanvasStartReply = z.object({ roomId: z.string(), slug: z.string(), board: z.string(), agent: z.object({ name: z.string() }), joinPath: z.string(), created: z.boolean() });

const ParticipantReply = z.object({ id: z.string(), name: z.string(), color: z.string() });
const CanvasJoinReply = z.object({ roomId: z.string(), slug: z.string(), board: z.string(), created: z.boolean(), participant: ParticipantReply, agent: z.object({ name: z.string() }), participants: z.array(ParticipantReply) });
const CanvasActReply = z.object({ ran: z.number(), said: z.array(z.string()), skipped: z.array(z.string()) });

/** `canvas start|join|act|show|leave|list|end`: talks to the running host's loopback `/canvas/sessions`. */
async function canvasCommand(positionals: string[], options: { title: string | undefined; prompt: string | undefined; as: string | undefined; color: string | undefined }): Promise<void> {
  const { title, prompt } = options;
  const [verb, slug] = positionals;
  const base = `${hostUrl()}/canvas/sessions`;
  const post = (url: string, body: unknown): Promise<Response> => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  switch (verb ?? "") {
    case "start": {
      const caller = detectCaller(systemCallerDeps);
      const assistant = process.env["RELAY_ASSISTANT"]?.trim();
      if (caller === null && (assistant === undefined || assistant === "")) throw new Error("canvas start: run this from an omp session (no omp session file found among this command's ancestors)");
      const body = {
        ...(slug === undefined ? {} : { slug }),
        ...(title === undefined ? {} : { title }),
        ...(prompt === undefined ? {} : { prompt }),
        caller: caller === null ? { assistant } : { sessionFile: caller.sessionFile, chatFile: caller.chatFile, ...(caller.assistant === undefined ? {} : { assistant: caller.assistant }) },
      };
      const room = CanvasStartReply.parse(await hostJson(await post(base, body), "canvas start"));
      console.log(`${room.created ? "Started" : "Rejoined"} a live canvas on "${room.board}" (board ${room.slug}, room ${room.roomId}) as ${room.agent.name}.`);
      console.log(`Isaac got a Join card in this chat. Your canvas self (${room.agent.name}, with this chat as context) runs the room on its own; each canvas turn and the wrap-up summary come back to this chat as canvas rows, nothing for you to do until then. End it early with: relay-linux canvas end ${room.slug}`);
      return;
    }
    case "join":
    case "act":
    case "leave": {
      if (slug === undefined) throw new Error(`canvas ${verb}: missing <slug>`);
      const name = options.as?.trim() ?? "";
      if (name === "") throw new Error(`canvas ${verb}: missing --as <Name> (the name your cursor shows)`);
      const room = `${base}/${encodeURIComponent(slug)}`;
      const joined = CanvasJoinReply.parse(
        await hostJson(
          await post(`${room}/participants`, { name, ...(prompt === undefined || verb !== "join" ? {} : { purpose: prompt }), ...(options.color === undefined ? {} : { color: options.color }) }),
          `canvas ${verb}`,
        ),
      );
      const me = joined.participant;
      if (verb === "leave") {
        await hostJson(await post(`${room}/participants/${encodeURIComponent(me.id)}/leave`, {}), "canvas leave");
        console.log(`${me.name} left "${joined.board}".`);
        return;
      }
      if (verb === "join") {
        const others = joined.participants.filter((p) => p.id !== me.id).map((p) => p.name);
        console.log(`${joined.created ? "Joined" : "Already in"} "${joined.board}" (board ${joined.slug}) as ${me.name} (${me.color}), next to ${[joined.agent.name, ...others].join(", ")}.`);
        console.log(`Read the board: relay-linux canvas show ${joined.slug}. Act: relay-linux canvas act ${joined.slug} --as "${me.name}" with action lines on stdin (skill://canvas section 8). Leave: relay-linux canvas leave ${joined.slug} --as "${me.name}".`);
        return;
      }
      const rest = positionals.slice(2);
      const script = rest.length === 0 || rest[0] === "-" ? await Bun.stdin.text() : rest.join(" ");
      const result = CanvasActReply.parse(await hostJson(await post(`${room}/participants/${encodeURIComponent(me.id)}/act`, { script }), "canvas act"));
      console.log(`${me.name}: ran ${String(result.ran)} action${result.ran === 1 ? "" : "s"}${result.said.length > 0 ? `, said ${String(result.said.length)} line${result.said.length === 1 ? "" : "s"}` : ""} on "${joined.board}".`);
      for (const line of result.skipped) console.log(`skipped: ${line}`);
      return;
    }
    case "show": {
      if (slug === undefined) throw new Error("canvas show: missing <slug>");
      console.log(JSON.stringify(await hostJson(await fetch(`${base}/${encodeURIComponent(slug)}`), "canvas show"), null, 2));
      return;
    }
    case "list": {
      const reply = await hostJson(await fetch(base), "canvas list");
      const { rooms } = CanvasRoomsReply.parse(reply);
      const participants = z.object({ participants: z.record(z.array(ParticipantReply)).optional() }).parse(reply).participants ?? {};
      if (rooms.length === 0) console.log("no canvas rooms");
      for (const room of rooms) {
        const agents = (participants[room.id] ?? []).map((p) => p.name);
        console.log(`${room.slug}  ${room.live ? "live" : "ended"}  "${room.board}"  ${room.agent.name}${agents.length > 0 ? ` + ${agents.join(", ")}` : ""}  chat ${room.chat.title ?? room.chat.sessionId ?? "-"}${room.humans.length > 0 ? `  here: ${room.humans.join(", ")}` : ""}`);
      }
      return;
    }
    case "end": {
      const { rooms } = CanvasRoomsReply.parse(await hostJson(await fetch(base), "canvas end"));
      const live = rooms.filter((room) => room.live);
      let room = slug === undefined ? undefined : live.find((candidate) => candidate.slug === slug);
      if (slug === undefined) {
        // This chat's room: omp names a transcript `<time>_<session id>.jsonl`; else the only live room.
        const chatFile = detectCaller(systemCallerDeps)?.chatFile;
        const sessionId = chatFile === undefined ? undefined : basename(chatFile, ".jsonl").split("_").at(-1);
        room = live.find((candidate) => sessionId !== undefined && candidate.chat.sessionId === sessionId) ?? (live.length === 1 ? live[0] : undefined);
        if (room === undefined) throw new Error(live.length === 0 ? "canvas end: no live canvas session" : `canvas end: several live sessions, name one: ${live.map((r) => r.slug).join(", ")}`);
      }
      if (room === undefined) throw new Error(`canvas end: no live canvas session on ${slug ?? ""}`);
      const { summary } = z.object({ summary: z.string() }).parse(await hostJson(await post(`${base}/${encodeURIComponent(room.id)}/end`, {}), "canvas end"));
      console.log(`Wrapped up "${room.board}". Summary (also posted to the chat): ${summary}`);
      return;
    }
    default:
      throw new Error(`canvas: expected start, join, act, show, leave, list or end\n\n${USAGE}`);
  }
}

/** `react <emoji> | --clear`: the running host puts assistant `agent`'s reaction on one of Isaac's bubbles in its thread. */
async function react(agent: string | undefined, positionals: string[], message: string | undefined, clear: boolean): Promise<void> {
  const id = agent ?? process.env["RELAY_ASSISTANT"];
  if (id === undefined || id === "") throw new Error("react: missing --agent <id> (or $RELAY_ASSISTANT)");
  const emoji = positionals[0];
  if (!clear && emoji === undefined) throw new Error("react: missing <emoji> (or --clear)");
  const response = await fetch(`${hostUrl()}/reactions/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: id, ...(clear ? { clear } : { emoji }), ...(message === undefined ? {} : { message }) }),
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const answer = (await response.json()) as { message: string; emoji: string | null };
  console.log(answer.emoji === null ? `cleared ${id}'s reaction on ${answer.message}` : `${id} reacted ${answer.emoji} to ${answer.message}`);
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
      message: { type: "string" },
      clear: { type: "boolean", default: false },
      canvases: { type: "string" },
      title: { type: "string" },
      prompt: { type: "string" },
      as: { type: "string" },
      color: { type: "string" },
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
        values.canvases ?? (process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "EvaOS", "canvases") : null),
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
    case "canvas":
      await canvasCommand(positionals.slice(1), { title: values.title, prompt: values.prompt, as: values.as, color: values.color });
      return;
    case "react":
      await react(values.agent, positionals.slice(1), values.message, values.clear);
      return;
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
