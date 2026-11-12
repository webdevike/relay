#!/usr/bin/env bun
// relay-linux: the Linux host daemon. `serve` (default) advertises the host, prints pairing
// PINs to this terminal, and injects phone input through /dev/uinput. `devices` / `forget`
// manage paired phones. `share` hands text, a URL or a file to the running daemon's drop box
// over its loopback HTTP endpoint; `serve` leaves its port in `relay/serve.json` so `share`
// can find it.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ControlResult, Drop, sessionReactionThread, type ServerMessage } from "@relay/protocol";
import type { LaunchOptions } from "./agents/herdr";
import { ASR_SCRIPT, AsrWorker, asrPython } from "./meetings/asr";
import { loadAutoname, MeetingPipeline, type Autoname } from "./meetings/pipeline";
import { MeetingsService } from "./meetings/service";
import { defaultMeetingsDir, RecordingStore } from "./meetings/store";
import { z } from "zod";
import { describeEntry } from "@relay/canvas-live/history";
import pkg from "../package.json";
import { bundleVersion } from "./bundle-version";
import { ensureOmpExtensions } from "./agents/extensions";
import { hasAiAccount, hostLogPath, ompAccounts } from "./assistant/ai-account";
import { handleAssistantFile } from "./assistant/files";
import type { FoundAsk, ListedAsk } from "./assistant/http";
import type { ConsultResult } from "./seams";
import { AssistantRegistry, type FieldChange } from "./assistant/admin";
import { defaultSocketPath, OmpBridgeProvider } from "./agents/bridge";
import { openBridgeLink, SubagentFileMirrors } from "./agents/subagent-mirrors";
import { ownedSessions } from "./agents/owned-sessions";
import { SessionFiles } from "./agents/session-files";
import {
  type AssistantAgentConfig,
  liveVoiceFor,
  loadRegistry,
  REGISTRY_FILE,
} from "./assistant/registry";
import { AssistantService, AssistantThreads, type AssistantThreadsDeps } from "./assistant/service";
import { spawnFill } from "./assistant/signin";
import { AskStore, defaultAsksPath } from "./assistant/ask-store";
import { claudeAskJudge } from "./assistant/ask-judge";
import { ago } from "./query/tools";
import { defaultAssistantPath, defaultAssistantsDir, FileAssistantStore } from "./assistant/store";
import { CallService } from "./call/service";
import { EvaRealtimeVoice } from "./call/voice";
import { readThreadMemory } from "./live/brief";
import { openAiKey, OpenAiLive } from "./live/openai";
import { LiveService } from "./live/service";
import { FileDeviceStore } from "./device-store";
import { embedFor } from "./drops/embed";
import { dropLimitsFromEnv, FileDropStore } from "./drops/store";
import {
  ffmpegProbe,
  probeVideoCodec,
  isVideoMime,
  maxVideoBytesFromEnv,
  videoMimeOf,
  VideoTooLarge,
} from "./drops/video";
import { FileBoardStore } from "./boards/store";
import { createUsageService, ompUsageRunner } from "./usage/service";
import { STATS_WARMUP_MS, createStatsService, ompStatsRunner, ompStatsSources, openStatsDb } from "./stats/service";
import { agentRow } from "./stats/agents";
import { ompRunner, SkillCatalog } from "./skills/catalog";
import { SkillsService } from "./skills/service";
import { SkillUsageIndex } from "./skills/usage";
import {
  CatchUpService,
  defaultCatchUpFeedPath,
  defaultCatchUpNotesPath,
  defaultCatchUpStatePath,
} from "./catchup/service";
import { defaultFeedDir, FeedService } from "./feed/service";
import { defaultReactionsPath, reactionFeedbackPath, ReactionService, replyReactionsFromEnv } from "./reactions/service";
import { defaultRenderFailuresPath, RenderFailureService } from "./render-failures/service";
import { BookmarkService, defaultBookmarksPath } from "./bookmarks/service";
import { ArtifactService, defaultArtifactsRoot } from "./artifacts/service";
import { ActivityService } from "./activity/service";
import { CalibrationLog } from "./eta/calibration";
import { RunHistory, sessionRoots, sessionSources } from "./eta/history";
import { formatReport, runEtaReport } from "./eta/report";
import { EtaService } from "./eta/service";
import { listHerdrAgents } from "./agents/herdr";
import { canvasAgentConfig, type CanvasAgentConfig } from "./canvas/agent-config";
import { mindConfigOverlay, ompMinds, resolveOmp } from "./canvas/brain";
import { MODELS } from "@relay/canvas-live/shared";
import { detectCaller, systemCallerDeps } from "./canvas/caller";
import { CANVAS_PAGE } from "./canvas/page";
import { CanvasInvitations } from "./push/canvas-invites";
import { CanvasService } from "./canvas/service";
import { detectTextTyper, KeyboardInjector } from "./input/keyboard";
import { MacInputDevice } from "./input/macos";
import { ClipboardPaster, systemCopy } from "./input/paste";
import type { EventPoster } from "./input/poster";
import { TrackpadInputSink } from "./input/trackpad";
import { UinputDevice } from "./input/uinput";
import { BonjourAdvertiser } from "./mdns";
import { PinFilePairingUI, TerminalPairingUI } from "./pairing";
import { PAIRING_TIMEOUT_MS, systemClock } from "./session";
import {
  appAgentHome,
  featureOn,
  human,
  loadHostConfig,
  relayConfigDir,
  resolveHuman,
  setHuman,
  toolPath,
  type HostConfig,
} from "./host-config";
import { ExpoPushSender } from "./push/expo";
import { InboxService } from "./inbox/service";
import { AttentionNotifier } from "./push/notifier";
import { FilePushTokenStore } from "./push/token-store";
import { RelayServer } from "./server";
import { DEFAULT_VNC_PORT } from "./vnc";
import { ClipboardWatcher, systemPaste, systemWatch } from "./drops/clipboard";
import { CodexRunner, ompCodexToken } from "./studio/codex";
import { HiggsfieldRunner, ompHiggsfieldCredentials } from "./studio/higgsfield";
import { KontextRunner } from "./studio/kontext";
import { ComfyUIRunner, defaultComfyDeps } from "./studio/comfyui";
import { CropRunner } from "./studio/crop";
import { FlockGpuLock } from "./studio/gpu-lock";
import { LtxRunner } from "./studio/ltx";
import { defaultQwenPlist, LaunchdLtxMemory, systemLaunchctl } from "./studio/ltx-memory";
import { defaultMossPaths, MossRunner } from "./studio/moss";
import { ffmpegMedia } from "./studio/media";
import { SamRunner } from "./studio/sam";
import { StudioService, type StudioMessage } from "./studio/service";
import { defaultStudioDir } from "./studio/store";
import { bunRun, defaultReviewsDir, resolveClaude, resolveGh } from "./reviews/exec";
import { linearKey } from "./reviews/linear";
import { goodopsSource } from "./query/goodops";
import { liveRender } from "./query/openui";
import { QueryService } from "./query/service";
import { queryTools } from "./query/tools";
import { ReviewsService } from "./reviews/service";
import { FilePresence } from "./files/presence";
import { ControlRelay } from "./control/relay";
import { roomsControlRequest, roomsOutput } from "./control/rooms-cli";

const USAGE = `relay-linux <command>

  Defaults for serve come from ~/.config/relay/host.json ({agentHome, name, port, human?,
  features?}) when it exists; the flags below win over it.
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
                                   elsewhere off) with omp from PATH or $RELAY_CANVAS_OMP; each
                                   room's canvas self is a full omp agent working in the agent
                                   home ($RELAY_CANVAS_MODEL opus, $RELAY_CANVAS_EFFORT low|medium,
                                   budget $RELAY_CANVAS_MAX_TURNS / _MAX_TOKENS / _MAX_TURN_MIN,
                                   idle stop $RELAY_CANVAS_IDLE_STOP_MIN).
                                   Studio keeps jobs in $XDG_CONFIG_HOME/relay/studio; local
                                   video runs <agent-home>/work/local-video/draft.py
                                   ($RELAY_STUDIO_LTX_DIR), Codex images and Higgsfield use
                                   omp's personal sign-ins.
                                   Reviews reads GitHub with gh, Linear with $LINEAR_API_KEY
                                   or <agent-home>/secrets/linear.env, Slack with claude
                                   ($RELAY_CLAUDE) and keeps its state in
                                   $XDG_CONFIG_HOME/relay/reviews; RELAY_REVIEWS_DRY_RUN=1
                                   refuses every post (a test host)
  devices                          list paired phones
  forget <deviceId>                remove a paired phone
  share <text | url | path> ...    add to the drop box of the running host: one existing file
                                   goes as a file, anything else as text; \`share -\` or no
                                   arguments reads stdin. A video (mp4/webm/mov) is capped at
                                   25 MB ($RELAY_MAX_VIDEO_MB on the host) and gets a poster;
                                   blobs also print what to paste: markdown \`![..](..)\` for
                                   image/video/audio, an openui Model() block for .glb/.gltf,
                                   a link for anything else, with warnings for formats the
                                   iPhone can't play (webm, non-H.264 video, ogg/opus)
  board list                       list the running host's dashboards
  board get <slug>                 print one dashboard
  board put <slug> [< json]        create/replace from {title, workspace?, icon?, widgets?}
  board ops <slug> [< json]        apply a BoardOp[] array, all or nothing
  board rm <slug>                  delete a dashboard
  assistant say --agent <id> <text> ...
                                   hand assistant thread <id> (from <agent-home>/${REGISTRY_FILE})
                                   of the running host a message from a background job; it
                                   relays it to Isaac. \`say -\` or no text reads stdin
  assistant consult --agent <id> [--title "Card title"] [--work] <question> ...
                                   from an assistant's session ($RELAY_ASSISTANT): bring
                                   assistant <id> into this chat and put the question to it in
                                   its own thread. It joins (Isaac sees it), answers as itself and
                                   leaves; the answer prints here. Work that takes longer than
                                   30 s (or --work) becomes a work card in this chat while it
                                   carries on in its own chat; the card shows its result when it
                                   is done. \`consult -\` or no question reads stdin
  rooms list | create '<json>' | update <roomId> '<json>' [--device <id or name>]
                                   from an assistant's session ($RELAY_ASSISTANT): set up a
                                   room in Relay Desktop (Assistants > Rooms) from this chat, or
                                   change one; created idle, nothing runs until Isaac speaks.
                                   create prints the card token to put on its own line in your
                                   reply. \`relay-linux rooms\` alone prints the JSON shape; - or
                                   no JSON reads stdin
  assistant list                   the running host's registry entries (JSON)
  assistant create --title <Name> [--scope "what it is for"] [--id <id>] [--start]
                                   add an assistant: registry entry, a first-run prime.md (it
                                   gets to know you by chatting, then writes its own
                                   instructions) and its thread memory. It shows on every phone
                                   and desktop at once; --start opens its thread
  assistant set --agent <id> [--title T] [--scope S] [--model M] [--voice V] [--live-voice V]
                [--unset <field>]...
                                   change an assistant's registry entry (--agent defaults to
                                   $RELAY_ASSISTANT); prints what changed
  assistant retire --agent <id>    take an assistant out of the registry (prime and memory stay)
  canvas start [<slug>] [--title "New board"] [--prompt "what this session is for"]
                                   from an omp session: start a live canvas on board <slug> (an
                                   EvaOS board; a new one when it does not exist or no slug is
                                   given). Isaac gets a Join card in this chat; the canvas agent
                                   is this chat's assistant (Nova in Nova's thread, else Eva) with
                                   the chat as context, and posts each turn and the wrap-up here
  canvas join <slug> --as <Name> [--prompt "what I am here to do"] [--color "#rrggbb"] [--session <id>|me]
                                   join a live room as an agent of your own (any omp session, a
                                   subagent too): your own cursor, name, color and portrait. With
                                   --session (a session id, a subagent's id, or me) you are a
                                   worker: the canvas self's @handoff <Name> and Isaac's "@<Name> ..."
                                   notes reach that session as messages
  canvas act <slug> [--as <Name>] [--handoff <id>] [--leave] [<lines> | -]
                                   run action lines as <Name> (joins first when needed), or without
                                   --as as the room's canvas self (the chat that started it): @say,
                                   @add_node, @add_image, @add_frame, @add_ui, @add_proto, @add_edge, @set_text,
                                   @append_text, @move_node, @point, @select, @cursor, @delete,
                                   @page_add, @page
                                   (skill://canvas sections 8-9); no lines or - reads stdin.
                                   --handoff lands that handoff (the canvas self confirms it);
                                   --leave takes <Name> out of the room after the batch
  canvas show <slug> --history [--since 2h|30m|<date>]
                                   the board's change log (who added, changed, moved or deleted what,
                                   when), folded and then entry by entry; works without a live room
  canvas restore <slug> <id> [--as <Name>]
                                   put a card or link back that the history says was deleted (with
                                   the links deleted with it); needs the live room. Agents: @restore <id>
  canvas show <slug>               the live room's pages (id, title, node count, who is on each), its
                                   board (page-1 at the top level, other pages under board.pages), who
                                   is in it (working or idle), open handoffs, what its canvas self has
                                   spent, and the latest chat (JSON)
  canvas leave <slug> --as <Name>  take <Name>'s cursor out of the room
  canvas list                      list the running host's canvas rooms
  catchup bounce <id> <reason> [--agent <id>]
                                   from an assistant's session: hand Catch Up card <id> back
                                   (--agent defaults to $RELAY_ASSISTANT)
  eta [--json] [--agent-home <dir>] how good the progress estimates on running badges are: past
                                   runs replayed (the latest fifth held out; tasks and agent
                                   sessions from the agent home the host app uses) and live runs
                                   logged in ~/.config/relay/eta-calibration.jsonl
  asks list [--agent <id>] [--json]
                                   the running host's open asks: questions an assistant asked
                                   Isaac (a reply ending on [[replies: ...]], or an omp ask) that
                                   he has not answered yet, one line each (--agent defaults to
                                   $RELAY_ASSISTANT, else every thread)
  asks resolve <id>... [--agent <id>] [--answer '<text>']
                                   from an assistant's session: close open asks that are settled
                                   some other way (Isaac answered in his own words); --answer
                                   records his answer and, for a session's ask, hands it to that
                                   session as "[answer to ask <id>] <text>"
  asks add --thread <id> --from '<session title>' --question '...' --options 'a|b|c'
           [--default 'a'] [--session <session id>|me]
                                   from any omp session: put a question to Isaac through assistant
                                   thread <id> (default $RELAY_ASSISTANT) as a badge above its
                                   composer; 1 to 8 options of up to 80 characters, --default one
                                   of them. His answer comes back to --session (default: the
                                   session running this) as "[answer to ask <id>] <answer>".
                                   Prints only the ask id
  asks get <id> [--json]           one ask, open or closed: its state, who asked, the question,
                                   the default, Isaac's answer and whether it reached the session
  canvas end [<slug>]              wrap up the live session on <slug> (default: this chat's)
  skills list [--json]             the skills omp loads on this host: source, who uses them, last use
  skills show <name> [--json]      one skill: its copies, files, use in the last 30 days
  skills edit <name> --as <Name> [--color "#rrggbb"] [--thread <id>] (--find <text> --replace <text> | --after <text> (--insert <md> | --stdin) | --file <md> | --stdin) [--save]
                                   edit a skill through its live doc, as your own named caret in
                                   Relay Desktop's Skills editor: --find (text as shown, unique, inside
                                   one block) is selected, then replaced as typed; --after adds the
                                   --insert markdown blocks after that text's block (as items of its
                                   list when they are a list); --file or --stdin is the whole SKILL.md
                                   (or its body) and only changed blocks move. --thread makes the edit
                                   a suggestion in that comment thread, accepted or rejected in the
                                   editor. --save writes SKILL.md afterwards (else Isaac saves)
  skills reply <name> <thread> --as <Name> [--resolve] (<text> | -)
                                   answer in a comment thread of the skill (- reads the text from stdin);
                                   --resolve resolves the thread too
  skills save <name> [--force]     write the live doc to SKILL.md; --force overwrites a file that
                                   changed on disk since it was opened
  skills leave <name> --as <Name>  take <Name>'s caret out of the skill (it leaves by itself after
                                   2 minutes without an edit)
  react <emoji> [--agent <id>] [--message latest|<key>]
  react --clear [--agent <id>] [--message latest|<key>]
                                   from an assistant's session: react to (or take back the
                                   reaction on) Isaac's newest message in its thread, or bubble
                                   <key> (\`user@<ms>\`); --agent defaults to $RELAY_ASSISTANT.
                                   Shown on his devices; never a turn or a push

Input goes through /dev/uinput: your user needs read/write on it (e.g. membership in the
\`input\` group, then log out and back in).`;

const ServeInfo = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int(),
  controlToken: z.string().optional(),
});

function serveInfoPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "serve.json");
}

/** Where the open pairing's PIN is left for Relay Desktop: `{pin, expiresAt, deviceName}`, 0600. */
function pairingPinPath(): string {
  return join(relayConfigDir(), "pairing.json");
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
  config: HostConfig | null,
): void {
  let registry: readonly AssistantAgentConfig[] = [];
  try {
    if (agentHome !== null) registry = loadRegistry(agentHome);
  } catch {
    // No registry: assistants are off and the lists below stay empty.
  }
  let device: UinputDevice | MacInputDevice | null = null;
  let accessRequested = false;
  try {
    device = process.platform === "darwin" ? new MacInputDevice() : new UinputDevice();
    if (device instanceof MacInputDevice) {
      // No prompt here: a new Mac would get an unexplained Accessibility dialog at login. The first
      // pointer/keyboard command from a phone asks instead (session `inputAllowed`).
      log(
        `macOS input: Accessibility ${device.granted ? "granted" : "not granted yet (asked on first phone input)"}`,
      );
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
  log(
    device instanceof MacInputDevice
      ? "text input: macOS Unicode"
      : typer === null
        ? "text input: uinput US layout (ASCII only; install wtype on Wayland for Unicode)"
        : "text input: wtype",
  );

  // The host may be started by a login item or launchd with no login-shell PATH: omp, herdr and
  // bun live in ~/.local/bin, ~/.bun/bin or Homebrew. Appended, so an existing PATH keeps priority.
  process.env["PATH"] = toolPath();
  void ensureOmpExtensions(log);
  const agents = new OmpBridgeProvider(defaultSocketPath(), log, agentHome);
  const pushTokens = new FilePushTokenStore();
  const drops = new FileDropStore(undefined, {
    maxVideoBytes: maxVideoBytesFromEnv(),
    ...dropLimitsFromEnv(),
    probe: ffmpegProbe(log),
  });
  // Live widgets' read-only data; `assistant` is only read once a query arrives, long after it is initialised.
  const query = new QueryService(
    queryTools({
      evaRoot: agentHome,
      run: bunRun,
      gh: resolveGh(),
      linearKey: () => linearKey(agentHome),
      fetch: globalThis.fetch,
      sessions: () => agents.sessions,
      assistants: () => assistant?.agents() ?? Promise.resolve([]),
      now: Date.now,
      goodops: goodopsSource(agentHome),
    }),
    Date.now,
    log,
  );
  const boards = boardsDir === null ? null : new FileBoardStore(boardsDir, log, liveRender(query));
  // Snapshots only flow once a phone asks (`usage.get`), long after `server` below is initialised.
  const usage = createUsageService({
    profilesDir: join(homedir(), ".omp", "profiles"),
    run: ompUsageRunner(),
    emit: (snapshot) => {
      server.broadcastExcept({ t: "usage.snapshot", usage: snapshot }, null);
    },
  });
  // The discovery feed `work/discovery-feed/fetch.ts` writes in the Eva hub; a host without that feed (and without features.feed) has none.
  const discoveryDir = defaultFeedDir(agentHome);
  const feed =
    discoveryDir !== null && featureOn(config, "feed", existsSync(join(discoveryDir, "feed.json"))) ? new FeedService(discoveryDir) : null;
  // Snapshots go out on feed or state changes, and handoffs reach the assistant threads, long after
  // `server` and `assistant` below are initialised.
  // Catch Up reads a feed an Eva job builds; a host without that feed (and without features.catchup) has none.
  const feedPath = defaultCatchUpFeedPath(agentHome);
  const catchupFeed =
    feedPath !== null &&
    featureOn(
      config,
      "catchup",
      existsSync(feedPath) || process.env["RELAY_CATCHUP_FEED"] !== undefined,
    )
      ? feedPath
      : null;
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
          // A handoff is the human's turn in that assistant's thread, as if they had typed it there.
          deliver: async (agent, text) => {
            const thread = assistant?.thread(agent);
            if (thread === undefined) throw new Error(`no assistant thread ${agent}`);
            await thread.turn(text);
          },
          knows: (agent) => assistant?.threads.some((thread) => thread.id === agent) ?? false,
          // Without the owner's Eva tools, scopes come from the registry and a bounce is this binary's `catchup bounce`.
          ...(config === null
            ? {}
            : {
                handoffOptions: {
                  scopes: registry
                    .map((agent) => `${agent.title}: ${agent.scope ?? "any work"}`)
                    .join("; "),
                  bounce: (id: string) => `"${process.execPath}" catchup bounce ${id} "<reason>"`,
                },
              }),
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
  // Registry writes (`assistant create|set|retire`, `assistant.create` from a device) and hand edits
  // reach the threads at once; the host CLI is what an assistant runs to change itself.
  const registryAdmin =
    agentHome === null
      ? null
      : new AssistantRegistry({
          agentHome,
          userName: human,
          cli: Bun.main.endsWith(".ts") ? `bun "${Bun.main}"` : `"${process.execPath}"`,
          log,
        });
  // One judge for every thread: did Isaac's later turns already answer an open ask?
  const askJudge = claudeAskJudge(bunRun, resolveClaude());
  const thread = (agent: AssistantAgentConfig): AssistantService =>
    new AssistantService({
      agent,
      agents,
      launch: (options) => agents.launchWith(options),
      sessionFile: (sessionId) => agents.sessionFile(sessionId),
      holder: (file) => agents.sessionForFile(file),
      close: (sessionId) => agents.close(sessionId),
      reconnected: () => agents.reconnected(),
      agentHome,
      store: new FileAssistantStore(defaultAssistantPath(agent.id)),
      asks: new AskStore(defaultAsksPath(agent.id)),
      judgeAsk: askJudge,
      tokens: pushTokens,
      sender: new ExpoPushSender(),
      broadcast: (message): void => {
        server.broadcastAssistant(agent.id, message);
      },
      isViewing: (deviceId): boolean => server.isViewingAssistant(deviceId, agent.id),
      clock: systemClock,
      log,
      spawn: spawnFill,
      aiAccount: () => hasAiAccount(ompAccounts(resolveOmp())),
      logPath: hostLogPath(),
    });
  const assistant = assistantThreads(agentHome, thread, {
    // The phones' agent list follows status and last-reply changes on its own, without waiting for a request.
    broadcast: (message): void => {
      server.broadcastExcept(message, null);
    },
    clock: systemClock,
    log,
    create: thread,
    ...(registryAdmin === null
      ? {}
      : { register: (input: unknown) => registryAdmin.create(input) }),
    ...(agentHome === null ? {} : { file: (req) => handleAssistantFile(agentHome, req) }),
    // One assistant brings another into its chat (`assistant consult`): guest rows go in through its bridge.
    guests: { post: (sessionId, content, details) => agents.guest(sessionId, content, details), human },
  });
  const stopRegistryWatch =
    registryAdmin === null || assistant === null
      ? null
      : (() => {
          registryAdmin.onChange = (entries) => {
            registry = entries;
            assistant.reload(entries);
          };
          return registryAdmin.watch();
        })();
  // Local voice calls run on Eva's speech stack (eva-realtime venv + pocket-tts); a host without it has none.
  const voiceRoot =
    agentHome === null
      ? null
      : (process.env["RELAY_VOICE_ROOT"] ?? join(agentHome, "apps", "eva-realtime"));
  const voice =
    assistant === null ||
    voiceRoot === null ||
    !featureOn(config, "voiceLocal", existsSync(voiceRoot))
      ? null
      : new EvaRealtimeVoice({
          root: voiceRoot,
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
              memory: () => readThreadMemory(agentHome, thread.id),
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
      if (thread.startsWith("assistant:"))
        return assistant?.thread(thread.slice("assistant:".length))?.current()?.id ?? null;
      const id = thread.slice("session:".length);
      return agents.sessions.some((session) => session.id === id && session.status !== "ended")
        ? id
        : null;
    },
    note: (sessionId, text) => agents.note(sessionId, text),
    clock: systemClock,
    log,
    reply: {
      emojis: replyReactionsFromEnv(),
      busy: (thread) => assistant?.thread(thread.slice("assistant:".length))?.current()?.status === "working",
      turn: async (thread, text) => {
        const target = assistant?.thread(thread.slice("assistant:".length));
        if (target === undefined) throw new Error(`no assistant thread ${thread}`);
        await target.turn(text);
      },
    },
  });
  const renderFailures = new RenderFailureService({
    path: defaultRenderFailuresPath(),
    assistant: (id) => assistant?.thread(id),
    sessions: () => agents.sessions,
    reply: (sessionId, text) => agents.reply(sessionId, text, true),
    clock: systemClock,
    log,
  });
  const bookmarks = new BookmarkService({
    path: defaultBookmarksPath(),
    broadcast: (message): void => {
      server.broadcastExcept(message, null);
    },
    log,
  });
  const repos = new Map<string, string | null>();
  let activity: ActivityService | null = null;
  const artifacts = new ArtifactService({
    root: defaultArtifactsRoot(),
    evaRoot: agentHome,
    broadcast: (message): void => {
      server.broadcastExcept(message, null);
      activity?.poke();
    },
    threadFiles: (thread) => {
      if (thread.startsWith("session:")) {
        const file = agents.sessionFile(thread.slice("session:".length));
        return file === null ? [] : [file];
      }
      const agent = thread.slice("assistant:".length);
      const record =
        assistant?.threads.some((candidate) => candidate.id === agent) === true
          ? new FileAssistantStore(defaultAssistantPath(agent)).load()
          : null;
      const live = assistant?.thread(agent)?.current();
      const liveFile = live === undefined ? null : agents.sessionFile(live.id);
      // Sessions the assistant owns (auto-work, delegated work: `RELAY_OWNER`) belong to its thread too, so
      // their helpers are its Artifacts rows and activity chips, in every profile they run under.
      const ownedFiles = agents.sessions
        .filter((session) => session.owner === agent && session.parentId === undefined)
        .map((session) => agents.sessionFile(session.id))
        .filter((file): file is string => file !== null);
      const files = [
        ...(record?.history ?? []),
        ...(record?.sessionFile === undefined ? [] : [record.sessionFile]),
        ...(liveFile === null ? [] : [liveFile]),
        ...ownedFiles,
      ];
      return [...new Set(files)];
    },
    threadOf: (sessionId) => {
      const session = agents.sessions.find((candidate) => candidate.id === sessionId);
      return session === undefined ? null : sessionReactionThread(session);
    },
    ownerThreadOf: (sessionId) => {
      const owner = agents.sessions.find((candidate) => candidate.id === sessionId)?.owner;
      return owner === undefined ? null : `assistant:${owner}`;
    },
    drop: (id) => drops.list().find((drop) => drop.id === id),
    repoOf: (cwd) => {
      const known = repos.get(cwd);
      if (known !== undefined) return known;
      const out = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
        out.stdout.toString().trim(),
      );
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
  const canvas = liveCanvas(canvasDir, agentHome, agents, () => registry, config);
  const eta = new EtaService({
    history: new RunHistory(join(relayConfigDir(), "eta-history.json"), sessionRoots(), () => sessionSources(agentHome), log),
    calibration: new CalibrationLog(join(relayConfigDir(), "eta-calibration.jsonl"), log),
    sessionFile: (sessionId) => agents.sessionFile(sessionId),
    isTask: (sessionId) => {
      const session = agents.sessions.find((candidate) => candidate.id === sessionId);
      return session !== undefined && (session.owner !== undefined || session.kind === "job");
    },
    sources: () => sessionSources(agentHome),
    now: () => Date.now(),
    log,
  });
  activity = new ActivityService({
    eta: (items) => eta.annotate(items),
    sessions: () => agents.sessions,
    question: (sessionId) => {
      const ask = agents.pendingAsk(sessionId);
      if (ask !== null) return ask.questions[0]?.question ?? null;
      const approval = agents.pendingApproval(sessionId);
      return approval === null
        ? null
        : `Approve ${approval.toolName}${approval.command === "" ? "" : `: ${approval.command}`}`.slice(
            0,
            300,
          );
    },
    helpers: () => artifacts.helpers(),
    harnesses: listHerdrAgents,
    rooms: () => canvas?.list() ?? [],
    roomCost: (slug) => {
      try {
        return canvas?.view(slug).usage.costUsd;
      } catch {
        return undefined;
      }
    },
    broadcast: (message): void => {
      server.broadcastExcept(message, null);
    },
    clock: systemClock,
    log,
  });
  // Jobs and state go out long after `server` below is initialised.
  // A call transcribed live holds new Studio GPU jobs until it ends; `meetings` exists by the time Studio asks.
  const studio = studioService(
    agentHome,
    config,
    (message) => {
      server.broadcastExcept(message, null);
    },
    () => meetings?.transcribingLive() === true,
  );
  // Reviews is Isaac's eCard queue, answered by his assistant Astra; a host without that assistant
  // (and without features.reviews) has no Reviews.
  const reviewsWrites = process.env["RELAY_REVIEWS_DRY_RUN"] !== "1";
  const reviews = !featureOn(config, "reviews", assistant?.thread("astra") !== undefined)
    ? null
    : new ReviewsService({
        dir: defaultReviewsDir(),
        agentHome,
        writes: reviewsWrites,
        run: bunRun,
        gh: resolveGh(),
        claude: resolveClaude(),
        fetch: globalThis.fetch,
        agents,
        launch: agentHome === null ? null : (options) => agents.launchJoined(options),
        sessionFile: (sessionId) => agents.sessionFile(sessionId),
        socketPath: defaultSocketPath(),
        // A Slack send request is a job message to Astra's main thread, as eva-thread.ts sends it.
        tellAstra: async (line) => {
          const thread = assistant?.thread("astra");
          if (thread === undefined) throw new Error("Astra's thread does not run on this host");
          await thread.say(line);
        },
        broadcast: (message) => {
          server.broadcastExcept(message, null);
        },
        clock: systemClock,
        log,
      });
  const meetings = meetingsService({
    agentHome,
    config,
    human: human(),
    agents,
    launch: agentHome === null ? null : (options) => agents.launchJoined(options),
    broadcast: (message) => {
      server.broadcastExcept(message, null);
    },
    push: (title, body, id) => {
      const messages = [...pushTokens.tokens()].map(([, token]) => ({
        to: token,
        title,
        body,
        data: { meeting: id },
        threadId: `meeting:${id}`,
      }));
      if (messages.length > 0)
        void new ExpoPushSender().send(messages).catch((error: unknown) => {
          log(`meetings push failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    onLiveChange: () => studio?.resume(),
  });
  // Agent cursors in Relay desktop's Files editor: who wrote which lines of an open file, and where Isaac's caret is.
  const files = new FilePresence({
    sessions: () => agents.sessions,
    registry: () => registry,
    // Plain chats' agent, named as on a canvas (liveCanvas below).
    defaultAgentName: () =>
      config === null || registry.length === 0 ? undefined : registry[0]?.title,
    clock: systemClock,
    log,
  });
  // Skill loads from every transcript on this Mac and the skill-usage hook's log, who made them, kept
  // warm across restarts. Settings > Usage attributes omp's per-session costs with the same records.
  const skillUsage = new SkillUsageIndex({
    home: homedir(),
    agentHome,
    assistantsDir: defaultAssistantsDir(),
    cacheFile: join(relayConfigDir(), "skill-usage.json"),
    logFile: join(homedir(), ".omp", "usage", "skills.jsonl"),
    log,
  });
  // The Skills page: every skill omp loads here, who loads it, and live editing in Relay Desktop.
  const skills = new SkillsService({
    catalog: new SkillCatalog({
      home: homedir(),
      evaRoot: agentHome,
      run: ompRunner(resolveOmp() ?? "omp", homedir()),
      list: ompRunner(resolveOmp() ?? "omp", agentHome ?? homedir()),
      log,
    }),
    usage: skillUsage,
    threadsDir: join(relayConfigDir(), "skill-threads"),
    // A comment in a skill is Isaac's turn in that assistant's thread, as a Catch Up handoff is.
    deliver: async (agent, text) => {
      const thread = assistant?.thread(agent);
      if (thread === undefined) throw new Error(`${agent} has no running thread on this host`);
      await thread.turn(text);
    },
    log,
  });
  // Settings > Usage on the desktop: omp stats of every profile, warmed after startup and refreshed
  // in the background when a desktop asks for a stale snapshot. Pushed only to sockets that asked.
  const ompForStats = resolveOmp();
  const stats =
    ompForStats === null
      ? null
      : createStatsService({
          sources: () => ompStatsSources(),
          sync: ompStatsRunner(ompForStats),
          open: openStatsDb,
          agentOf: async () => {
            const runnerOf = await skillUsage.runners();
            return (sessionFile) => agentRow(runnerOf(sessionFile));
          },
          emit: (snapshot) => {
            server.broadcastStats({ t: "stats.snapshot", stats: snapshot });
          },
          log,
        });
  // Agents on this Mac drive Relay Desktop on whichever Mac Isaac is using; the token is in serve.json.
  // One token: it also gates every state-changing loopback route (server.ts `guardWrite`), so it exists even when remote control is off.
  const hostToken = randomBytes(32).toString("hex");
  const control = featureOn(config, "control", true) ? new ControlRelay(hostToken, systemClock, log) : null;
  log(`live view: VNC bridge to 127.0.0.1:${String(vncPort)} (macOS Screen Sharing)`);
  const server: RelayServer = new RelayServer(
    { port, hostName: name, version: bundleVersion() ?? pkg.version, vncPort },
    {
      input: new TrackpadInputSink(poster),
      text: new KeyboardInjector(poster, typer),
      access: {
        get granted() {
          return device instanceof MacInputDevice ? device.granted : device !== null;
        },
        request: () => {
          if (!(device instanceof MacInputDevice) || accessRequested) return;
          accessRequested = true;
          device.requestAccess();
        },
      },
      images,
      agents,
      devices: new FileDeviceStore(),
      push: pushTokens,
      drops,
      boards,
      notifier,
      inbox,
      assistant,
      assistantAdmin: { registry: registryAdmin },
      calls,
      live,
      usage,
      stats,
      catchup,
      feed,
      reactions,
      bookmarks,
      artifacts,
      activity,
      canvas,
      sessionFiles: new SessionFiles(),
      studio,
      reviews,
      query,
      files,
      meetings,
      control,
      renderFailures,
      hostToken,
      skills,
      canvasPage: () => CANVAS_PAGE,
      pairing: new PinFilePairingUI(new TerminalPairingUI(), pairingPinPath(), PAIRING_TIMEOUT_MS),
      log,
    },
  );
  rmSync(pairingPinPath(), { force: true });
  const boundPort = server.start();
  skills.start();
  // Off the startup path: the first sync of a large profile reads every transcript.
  if (stats !== null) setTimeout(() => void stats.refresh(), STATS_WARMUP_MS).unref();
  if (canvas !== null) {
    // The server's own hook pushes `canvas.rooms` to the devices; a new live room also invites the phones.
    const invitations = new CanvasInvitations({ tokens: pushTokens, sender: new ExpoPushSender(), log });
    invitations.seed(canvas.list());
    const broadcast = canvas.onChange;
    canvas.onChange = () => {
      broadcast?.();
      invitations.observe(canvas.list());
    };
  }
  activity.start();
  // Helpers the omp extension never mirrored still get a session to open, read from their transcript.
  // Held back until omps that outlived a host restart have reconnected, so their real mirrors win.
  const subagentMirrors = new SubagentFileMirrors({
    helpers: () => artifacts.helpers(),
    sessions: () => agents.sessions,
    sessionForFile: (file) => agents.sessionForFile(file),
    open: openBridgeLink(defaultSocketPath(), log),
    owned: () => (agentHome === null ? [] : ownedSessions(agentHome, Date.now())),
    now: () => Date.now(),
    log,
  });
  void agents.reconnected().then(() => {
    subagentMirrors.start();
  });
  const infoPath = serveInfoPath();
  mkdirSync(dirname(infoPath), { recursive: true, mode: 0o700 });
  writeFileSync(infoPath, JSON.stringify({ port: boundPort, pid: process.pid, controlToken: hostToken }), { mode: 0o600 });
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
  log(
    boardsDir === null
      ? "boards disabled (no --boards or $RELAY_BOARDS_DIR)"
      : `boards stored in ${boardsDir}`,
  );

  const advertiser = new BonjourAdvertiser(name, boundPort, log);
  advertiser.start();
  log(`advertising _relay._tcp via ${advertiser.tool}`);

  clipboard?.start();
  catchup?.start();
  studio?.start();
  meetings?.start();
  log(
    reviews === null
      ? "reviews disabled (no astra assistant and no features.reviews)"
      : `reviews in ${defaultReviewsDir()}${reviewsWrites ? "" : " (RELAY_REVIEWS_DRY_RUN=1: nothing is posted)"}`,
  );
  log(
    catchupFeed === null
      ? "catch up disabled (no feed, or no --agent-home / $RELAY_CATCHUP_FEED)"
      : `catch up feed ${catchupFeed}`,
  );
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
    rmSync(pairingPinPath(), { force: true });
    advertiser.stop();
    canvas?.stop();
    activity?.stop();
    subagentMirrors.stop();
    studio?.stop();
    reviews?.stop();
    meetings?.stop();
    skills.stop();
    server.stop();
    voice?.stop();
    stopRegistryWatch?.();
    catchup?.stop();
    device?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Live canvas rooms on the boards in `canvasDir`, each with its canvas self as a full omp agent
 * (canvas/agent-config.ts); null (and logged) without a canvases dir, an omp binary, or with a bad
 * $RELAY_CANVAS_* setting.
 */
function liveCanvas(
  canvasDir: string | null,
  agentHome: string | null,
  agents: OmpBridgeProvider,
  registry: () => readonly AssistantAgentConfig[],
  config: HostConfig | null,
): CanvasService | null {
  if (canvasDir === null) {
    log("live canvas disabled (no --canvases)");
    return null;
  }
  const omp = resolveOmp();
  if (omp === null) {
    log("live canvas disabled: omp not found (set $RELAY_CANVAS_OMP)");
    return null;
  }
  let agentConfig: CanvasAgentConfig;
  try {
    agentConfig = canvasAgentConfig();
  } catch (error) {
    log(`live canvas disabled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const configDir = relayConfigDir();
  const home = agentHome ?? homedir();
  // The sign-ins live in omp's `personal` profile on the owner's host; a starter host has only omp's default.
  const profile = existsSync(join(homedir(), ".omp", "profiles", "personal")) ? "personal" : null;
  log(
    `live canvas on boards in ${canvasDir}: canvas self ${MODELS[agentConfig.model].id} (${agentConfig.effort}) via ${omp}, working in ${home}; per room ${String(agentConfig.maxRequests)} requests, ${String(Math.round(agentConfig.maxTokens / 1000))}k tokens`,
  );
  return new CanvasService({
    canvasDir,
    chats: agents,
    // Read on use, so an assistant added while the host runs joins rooms with its own face.
    get registry() {
      return registry();
    },
    ...(config === null || registry().length === 0
      ? {}
      : { defaultAgentName: registry()[0]?.title ?? "" }),
    minds: ompMinds({
      omp,
      profile,
      configs: [mindConfigOverlay(configDir)],
      stateDir: join(configDir, "canvas", "rooms"),
      agentHome: home,
      canvasDir,
      config: agentConfig,
      log,
    }),
    model: agentConfig.model,
    agentHome: home,
    log,
  });
}

/**
 * Meetings in `$XDG_CONFIG_HOME/relay/meetings`: recordings from every Mac's Relay Meetings helper,
 * transcribed by relay-asr (`apps/linux/asr`, venv from `setup.sh`; without it recordings are kept
 * but not transcribed), notes in `<agent-home>/work/meetings/shadow` while `features.meetingsShadow`
 * is on (the default; MeetingTranscriber still owns the journal) and `work/meetings/protocols` after
 * cutover. Off without an agent home or with `features.meetings: false`.
 */
function meetingsService(o: {
  agentHome: string | null;
  config: HostConfig | null;
  human: string;
  agents: OmpBridgeProvider;
  launch: ((options: LaunchOptions) => Promise<{ readonly joined: Promise<string> }>) | null;
  broadcast: (message: ServerMessage) => void;
  push: (title: string, body: string, id: string) => void;
  onLiveChange: () => void;
}): MeetingsService | null {
  if (!featureOn(o.config, "meetings", o.agentHome !== null)) {
    log("meetings disabled (no agent home and no features.meetings)");
    return null;
  }
  const store = new RecordingStore(defaultMeetingsDir());
  const shadow = featureOn(o.config, "meetingsShadow", true);
  const protocolsDir = join(
    o.agentHome ?? join(homedir(), "Eva"),
    "work",
    "meetings",
    shadow ? "shadow" : "protocols",
  );
  let service: MeetingsService | null = null;
  const asr = AsrWorker.available()
    ? new AsrWorker({
        onLine: (line) => service?.line(line),
        onTurns: (turns) => service?.turns(turns),
        onRestart: () => service?.workerRestarted(),
        voices: join(store.root, "voices.json"),
        mtSpeakers: join(homedir(), "Library", "Application Support", "MeetingTranscriber", "speakers.json"),
        log,
      })
    : null;
  let autoname: Promise<Autoname | null> | null = null;
  const pipeline = new MeetingPipeline({
    store,
    asr,
    agentHome: o.agentHome,
    protocolsDir,
    human: o.human,
    claude: resolveClaude(),
    run: bunRun,
    autoname: () => (autoname ??= loadAutoname(o.agentHome, log)),
    log,
  });
  service = new MeetingsService({
    store,
    asr,
    agentHome: o.agentHome,
    shadow,
    human: o.human,
    afterCall: pipeline,
    agents: o.agents,
    launch: o.launch,
    sessionFile: (sessionId) => o.agents.sessionFile(sessionId),
    socketPath: defaultSocketPath(),
    broadcast: o.broadcast,
    push: o.push,
    onLiveChange: o.onLiveChange,
    clock: systemClock,
    log,
    // Read per meeting: a registry edit routes the next meeting without a restart.
    assistants: () => {
      if (o.agentHome === null) return [];
      try {
        return loadRegistry(o.agentHome);
      } catch {
        return [];
      }
    },
  });
  log(
    `meetings in ${defaultMeetingsDir()}, notes in ${protocolsDir}${shadow ? " (shadow)" : ""}, transcription ${asr === null ? `off (no ${existsSync(asrPython()) ? ASR_SCRIPT : asrPython()})` : "by relay-asr"}`,
  );
  return service;
}

/**
 * Studio in `$XDG_CONFIG_HOME/relay/studio`: local LTX video from `<agent-home>/work/local-video`
 * (`$RELAY_STUDIO_LTX_DIR`), local MOSS-Image from `<agent-home>/work/local-higgsfield/moss-mlx`, ComfyUI
 * presets on the local server (its output and input dirs under `<agent-home>/work/local-higgsfield/ComfyUI`),
 * local SAM 2.1 and crops, Codex images on omp's personal ChatGPT sign-in, Higgsfield on omp's personal
 * Higgsfield sign-in. Local GPU work shares `~/.cache/eva-gpu.lock` (`$EVA_GPU_LOCK`) with every other GPU
 * user on this Mac. Null (and logged) when its index can't be read.
 */
function studioService(
  agentHome: string | null,
  config: HostConfig | null,
  emit: (message: StudioMessage) => void,
  gpuHeld: () => boolean,
): StudioService | null {
  const ltxDir =
    process.env["RELAY_STUDIO_LTX_DIR"] ??
    join(agentHome ?? join(homedir(), "Eva"), "work", "local-video");
  // Studio runs on the owner's LTX install and omp's `personal` sign-ins; without either (and without features.studio) it is off.
  if (
    !featureOn(
      config,
      "studio",
      existsSync(ltxDir) || existsSync(join(homedir(), ".omp", "profiles", "personal")),
    )
  ) {
    log("studio disabled (no local video install or personal omp profile, and no features.studio)");
    return null;
  }
  const media = ffmpegMedia(log);
  const token = ompCodexToken(resolveOmp());
  const home = agentHome ?? join(homedir(), "Eva");
  const comfyui = new ComfyUIRunner(defaultComfyDeps("comfyui", home));
  const comfyuiVideo = new ComfyUIRunner(defaultComfyDeps("comfyui-video", home));
  const sam = new SamRunner();
  try {
    const studio = new StudioService({
      dir: defaultStudioDir(),
      gpuHeld,
      runners: {
        ltx: new LtxRunner(
          ltxDir,
          undefined,
          new LaunchdLtxMemory({
            freeComfy: [() => comfyui.release(), () => comfyuiVideo.release()],
            launchctl: systemLaunchctl,
            uid: process.getuid?.() ?? 501,
            qwenPlist: defaultQwenPlist(),
            log,
          }),
        ),
        "codex-image": new CodexRunner({
          backend: "codex-image",
          token,
          fetch,
          jpeg: media.jpeg,
          cover: media.cover,
        }),
        "codex-edit": new CodexRunner({
          backend: "codex-edit",
          token,
          fetch,
          jpeg: media.jpeg,
          cover: media.cover,
        }),
        moss: new MossRunner(defaultMossPaths(home), () => comfyui.release()),
        kontext: new KontextRunner(),
        comfyui,
        "comfyui-video": comfyuiVideo,
        sam,
        crop: new CropRunner(media),
        higgsfield: new HiggsfieldRunner({
          credentials: ompHiggsfieldCredentials(
            join(homedir(), ".omp", "profiles", "personal", "agent", "agent.db"),
          ),
          fetch,
          now: Date.now,
          sleep: (ms, signal) => delay(ms, undefined, { signal }),
        }),
      },
      segmenter: sam,
      gpuLock: new FlockGpuLock(),
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
 * One thread per agent in `<agentHome>/.omp/assistant/agents.json`, read at start and reloaded on
 * every change (`AssistantRegistry.watch`); null (and logged) when there is no agent home or the
 * registry is missing or invalid at start.
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

/** serve.json as `serve` left it, or null when no host is running. */
function readServeInfo(): z.infer<typeof ServeInfo> | null {
  try {
    return ServeInfo.parse(JSON.parse(readFileSync(serveInfoPath(), "utf8")));
  } catch {
    return null;
  }
}

/**
 * The running host's loopback base URL: `$RELAY_HOST_URL` (a host on another port hands it to the
 * sessions it starts), else the port `serve` left in serve.json.
 */
function hostUrl(): string {
  const override = process.env["RELAY_HOST_URL"]?.trim();
  if (override !== undefined && override !== "") return override.replace(/\/+$/, "");
  const info = readServeInfo();
  if (info === null) throw new Error("relay-linux serve is not running");
  return `http://127.0.0.1:${info.port}`;
}

/** The host's bearer token: `$RELAY_HOST_TOKEN` (handed down with `$RELAY_HOST_URL`), else serve.json's `controlToken`. */
function resolveHostToken(): string {
  const env = process.env["RELAY_HOST_TOKEN"]?.trim();
  if (env !== undefined && env !== "") return env;
  const token = readServeInfo()?.controlToken;
  if (token === undefined) throw new Error("relay-linux serve is not running (no token in serve.json)");
  return token;
}

/** `fetch` to the running host with its bearer token: every state-changing loopback route requires it. */
function hostFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${resolveHostToken()}`);
  return globalThis.fetch(url, { ...init, headers });
}

/** `share` body: one existing file goes as a blob, anything else (or stdin) as text. */
async function share(positionals: string[]): Promise<void> {
  const url = `${hostUrl()}/drops`;
  let response: Response;
  // The video codec, probed here on the original so `share` can warn about a video the iPhone won't play.
  let codec: string | undefined;
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
    if (isVideoMime(videoMimeOf(name, type))) codec = await probeVideoCodec(single);
    response = await hostFetch(url, {
      method: "POST",
      headers: { "content-type": type, "x-drop-name": name },
      body: await file.bytes(),
    });
  } else {
    const text =
      positionals.length === 0 || single === "-" ? await Bun.stdin.text() : positionals.join(" ");
    response = await hostFetch(url, {
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
  // Blob drops also print their fetch path so an agent can reference it (e.g. a Compare widget),
  // then exactly what to paste to show it inline for its type (embedFor): markdown for images,
  // video and audio, an openui Model block for GLB/GLTF, a plain link for anything else.
  const embed = embedFor({ name: drop.file.name, mimeType: drop.file.mimeType, path: drop.file.path, ...(codec === undefined ? {} : { codec }) });
  const video = embed.kind === "video";
  const audio = embed.kind === "audio";
  console.log(`shared ${embed.kind} ${drop.id} ${drop.file.path}`);
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
  if (audio) {
    const facts = [
      durationMs === undefined ? "duration unknown (ffprobe missing on the host)" : `${(durationMs / 1000).toFixed(1)}s`,
      `${(drop.file.size / (1024 * 1024)).toFixed(1)} MB`,
      drop.file.mimeType,
    ];
    console.log(`audio ${facts.join(" · ")}`);
  }
  for (const line of embed.lines) console.log(line);
  for (const line of embed.warnings) console.error(line);
}

/** `assistant say --agent <id> <text>`: the running host hands the text to agent `id` as a turn from the host's jobs. */
async function assistantSay(agent: string | undefined, positionals: string[]): Promise<void> {
  if (agent === undefined || agent === "") throw new Error("assistant say: missing --agent <id>");
  const text =
    positionals.length === 0 || positionals[0] === "-"
      ? await Bun.stdin.text()
      : positionals.join(" ");
  const response = await hostFetch(`${hostUrl()}/assistant/say?agent=${encodeURIComponent(agent)}`, {
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

/** `assistant consult --agent <id> <question>`: brings assistant `id` into the calling assistant's chat (`POST /assistant/consult`). */
async function assistantConsult(options: { agent: string | undefined; title: string | undefined; work: boolean }, positionals: string[]): Promise<void> {
  const from = process.env["RELAY_ASSISTANT"]?.trim();
  if (from === undefined || from === "") throw new Error("assistant consult: run this from an assistant's session ($RELAY_ASSISTANT is not set)");
  if (options.agent === undefined || options.agent === "") throw new Error("assistant consult: missing --agent <id> (the assistant to bring in)");
  const question = (positionals.length === 0 || positionals[0] === "-" ? await Bun.stdin.text() : positionals.join(" ")).trim();
  if (question === "") throw new Error("assistant consult: missing <question>");
  const response = await hostFetch(`${hostUrl()}/assistant/consult`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, agent: options.agent, question, ...(options.title === undefined ? {} : { title: options.title }), ...(options.work ? { work: true } : {}) }),
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const result = (await response.json()) as ConsultResult;
  if (result.kind === "answer") {
    console.log(`${options.agent} answered in the chat (Isaac sees it as their own message, so do not repeat it):\n\n${result.text}`);
    return;
  }
  console.log(`${options.agent} is working on "${result.title}" in their own chat. A work card is in this chat and shows the result when they finish (work ${result.id}).`);
}

/** `rooms create|update|list`: the desktop's rooms.* agent action through `POST /control/run`, as the calling assistant. */
async function roomsCommand(verb: string | undefined, args: string[], device: string | undefined): Promise<void> {
  const body = await roomsControlRequest({ verb, args, stdin: () => Bun.stdin.text(), assistant: process.env["RELAY_ASSISTANT"]?.trim() || undefined, device });
  const response = await hostFetch(`${hostUrl()}/control/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = ControlResult.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    console.error(`rooms ${verb}: Relay Host answered ${String(response.status)} ${response.statusText}`);
    process.exit(1);
  }
  const out = roomsOutput(body.action, parsed.data);
  for (const line of out.lines) (out.ok ? console.log : console.error)(line);
  if (!out.ok) process.exit(1);
}

interface AssistantCliOptions {
  readonly agent: string | undefined;
  readonly id: string | undefined;
  readonly title: string | undefined;
  readonly scope: string | undefined;
  readonly model: string | undefined;
  readonly voice: string | undefined;
  readonly liveVoice: string | undefined;
  readonly unset: readonly string[];
  readonly start: boolean;
}

/** A change as the assistant reports it: `scope: "Personal" -> "Driving"`. */
function describeChange(change: FieldChange): string {
  const show = (value: unknown): string =>
    value === null
      ? "(none)"
      : typeof value === "object" && "seed" in value
        ? `face ${String(value.seed)}`
        : JSON.stringify(value);
  return `${change.field}: ${show(change.from)} -> ${show(change.to)}`;
}

/** `assistant list|create|set|retire`: the running host's registry. */
async function assistantAdminCommand(verb: string, options: AssistantCliOptions): Promise<void> {
  const base = `${hostUrl()}/assistant`;
  const agent = options.agent ?? process.env["RELAY_ASSISTANT"];
  const need = (): string => {
    if (agent === undefined || agent === "")
      throw new Error(`assistant ${verb}: missing --agent <id> (or $RELAY_ASSISTANT)`);
    return agent;
  };
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await hostFetch(`${base}${path}`, init);
    if (!response.ok) {
      console.error(await response.text());
      process.exit(1);
    }
    return response;
  };
  const json = (body: unknown): RequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  switch (verb) {
    case "list":
      console.log(JSON.stringify(await (await call("/registry")).json(), null, 2));
      return;
    case "create": {
      if (options.title === undefined) throw new Error("assistant create: missing --title <Name>");
      const body = {
        title: options.title,
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        start: options.start,
      };
      const entry = (await (await call("/registry", { method: "POST", ...json(body) })).json()) as {
        id: string;
        title: string;
      };
      console.log(
        `created ${entry.title} (${entry.id})${options.start ? "; its thread has started" : ""}`,
      );
      return;
    }
    case "set": {
      const id = need();
      const fields: Record<string, unknown> = {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.voice === undefined ? {} : { voice: options.voice }),
        ...(options.liveVoice === undefined ? {} : { liveVoice: options.liveVoice }),
        ...Object.fromEntries(options.unset.map((field) => [field, null])),
      };
      if (Object.keys(fields).length === 0) throw new Error("assistant set: nothing to change");
      const { changes } = (await (
        await call(`/registry/${encodeURIComponent(id)}`, { method: "PATCH", ...json(fields) })
      ).json()) as { changes: FieldChange[] };
      console.log(
        changes.length === 0
          ? "nothing changed"
          : `changed ${changes.map(describeChange).join("; ")}`,
      );
      return;
    }
    case "retire": {
      const id = need();
      const entry = (await (
        await call(`/registry/${encodeURIComponent(id)}`, { method: "DELETE" })
      ).json()) as { title: string };
      console.log(`retired ${entry.title} (${id}); its prime.md and thread memory stay`);
      return;
    }
    default:
      throw new Error(
        `assistant: unknown subcommand ${verb}; try say, consult, list, create, set or retire`,
      );
  }
}

/** `catchup bounce <id> <reason>`: the running host gets Catch Up card `id` handed back by assistant `agent`. */
async function catchupBounce(agent: string | undefined, positionals: string[]): Promise<void> {
  const [id, ...reason] = positionals;
  if (agent === undefined || agent === "")
    throw new Error("catchup bounce: missing --agent <id> (or $RELAY_ASSISTANT)");
  if (id === undefined || reason.length === 0)
    throw new Error("catchup bounce: expected <id> <reason>");
  const response = await hostFetch(`${hostUrl()}/catchup/bounce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, agent, reason: reason.join(" ") }),
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  console.log(`bounced ${id}`);
}

/** `asks list`: the running host's open asks of assistant `agent`, or of every thread when undefined. */
async function asksList(agent: string | undefined, json: boolean): Promise<void> {
  const query = agent === undefined || agent === "" ? "" : `?agent=${encodeURIComponent(agent)}`;
  const response = await hostFetch(`${hostUrl()}/assistant/asks${query}`);
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const { asks } = (await response.json()) as { asks: ListedAsk[] };
  if (json) {
    console.log(JSON.stringify(asks, null, 2));
    return;
  }
  if (asks.length === 0) {
    console.log("no open asks");
    return;
  }
  const now = Date.now();
  for (const ask of asks) {
    const replies = ask.replies.length === 0 ? "" : `  [${ask.replies.join(" | ")}]`;
    console.log(`${ask.id}  ${ask.agent}  ${ago(ask.at, now)}  ${ask.label}: ${ask.question}${replies}`);
  }
}

/** `asks resolve <id>...`: the running host closes each open ask, as answered with `answer` (delivered to a session's ask) or else as resolved by the assistant. */
async function asksResolve(agent: string | undefined, ids: string[], answer: string | undefined): Promise<void> {
  if (ids.length === 0) throw new Error("asks resolve: expected <id>...");
  let failed = false;
  for (const id of ids) {
    const response = await hostFetch(`${hostUrl()}/assistant/asks/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...(agent === undefined || agent === "" ? {} : { agent }), ...(answer === undefined ? {} : { answer }) }),
    });
    if (!response.ok) {
      console.error(await response.text());
      failed = true;
      continue;
    }
    const ask = (await response.json()) as FoundAsk;
    console.log(`${ask.state} ${ask.id} (${ask.label})`);
  }
  if (failed) process.exit(1);
}

/** `asks add`: puts the calling session's question to Isaac through assistant thread `thread`; prints only the ask id. */
async function asksAdd(options: {
  thread: string | undefined;
  from: string | undefined;
  session: string | undefined;
  question: string | undefined;
  options: string | undefined;
  default: string | undefined;
}): Promise<void> {
  if (options.thread === undefined || options.thread === "")
    throw new Error("asks add: missing --thread <assistant id> (or $RELAY_ASSISTANT)");
  if (options.from === undefined) throw new Error("asks add: missing --from '<session title>'");
  if (options.question === undefined) throw new Error("asks add: missing --question '...'");
  if (options.options === undefined) throw new Error("asks add: missing --options 'a|b|c'");
  // Without --session the answer goes back to the omp session running this, when there is one.
  const session =
    options.session === "me" || (options.session === undefined && detectCaller(systemCallerDeps) !== null)
      ? ownSessionRef("asks add --session me")
      : options.session;
  const response = await hostFetch(`${hostUrl()}/assistant/asks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      thread: options.thread,
      from: options.from,
      question: options.question,
      options: options.options.split("|"),
      ...(session === undefined ? {} : { session }),
      ...(options.default === undefined ? {} : { default: options.default }),
    }),
  });
  if (!response.ok) {
    console.error(`asks add: ${await response.text()}`);
    process.exit(1);
  }
  const { id } = (await response.json()) as { id: string };
  console.log(id);
}

/** `asks get <id>`: one ask of the running host, open or closed, with Isaac's answer. */
async function asksGet(id: string | undefined, json: boolean): Promise<void> {
  if (id === undefined) throw new Error("asks get: expected <id>");
  const response = await hostFetch(`${hostUrl()}/assistant/asks/${encodeURIComponent(id)}`);
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const ask = (await response.json()) as FoundAsk;
  if (json) {
    console.log(JSON.stringify(ask, null, 2));
    return;
  }
  const replies = ask.replies.length === 0 ? "" : `  [${ask.replies.join(" | ")}]`;
  console.log(`${ask.id}  ${ask.agent}  ${ask.state}  ${ask.from === undefined ? "" : `${ask.from}: `}${ask.question}${replies}`);
  if (ask.default !== undefined) console.log(`default: ${ask.default}`);
  const delivery = ask.source !== "session" || ask.answer === undefined ? "" : ask.delivered ? " (delivered)" : " (not delivered)";
  console.log(`answer: ${ask.answer ?? "none"}${delivery}`);
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

const CanvasRoomsReply = z.object({
  rooms: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      board: z.string(),
      live: z.boolean(),
      agent: z.object({ name: z.string() }),
      chat: z.object({ sessionId: z.string().optional(), title: z.string().optional() }),
      humans: z.array(z.string()),
    }),
  ),
});
const CanvasStartReply = z.object({
  roomId: z.string(),
  slug: z.string(),
  board: z.string(),
  agent: z.object({ name: z.string() }),
  joinPath: z.string(),
  created: z.boolean(),
});

const ParticipantReply = z.object({ id: z.string(), name: z.string(), color: z.string() });
const CanvasJoinReply = z.object({
  roomId: z.string(),
  slug: z.string(),
  board: z.string(),
  created: z.boolean(),
  participant: ParticipantReply,
  agent: z.object({ name: z.string() }),
  participants: z.array(ParticipantReply),
});
const CanvasActReply = z.object({
  ran: z.number(),
  said: z.array(z.string()),
  skipped: z.array(z.string()),
});
const CanvasHistoryReply = z.object({
  entries: z.array(
    z.object({
      ts: z.number(),
      who: z.string(),
      role: z.enum(["human", "agent", "worker"]),
      op: z.enum(["add", "update", "move", "delete", "restore"]),
      kind: z.enum(["node", "edge", "thread", "page"]),
      id: z.string(),
      label: z.string(),
      page: z.string(),
      count: z.number().optional(),
    }),
  ),
  summary: z.array(z.string()),
});

/** `--session me`: the id the bridge knows the calling omp session by (a subagent's agent id, else the chat's session id); `what` names the command in errors. */
function ownSessionRef(what: string): string {
  const caller = detectCaller(systemCallerDeps);
  if (caller === null) throw new Error(`${what}: run this from an omp session`);
  if (caller.sessionFile !== caller.chatFile) return basename(caller.sessionFile, ".jsonl");
  const id = basename(caller.chatFile, ".jsonl").split("_").at(-1);
  if (id === undefined || id === "")
    throw new Error(`${what}: cannot tell this session's id from its transcript name`);
  return id;
}

/** `canvas start|join|act|show|leave|list|end`: talks to the running host's loopback `/canvas/sessions`. */
async function canvasCommand(
  positionals: string[],
  options: {
    title: string | undefined;
    prompt: string | undefined;
    as: string | undefined;
    color: string | undefined;
    session: string | undefined;
    handoff: string | undefined;
    leave: boolean;
    history: boolean;
    since: string | undefined;
  },
): Promise<void> {
  const { title, prompt } = options;
  const [verb, slug] = positionals;
  const base = `${hostUrl()}/canvas/sessions`;
  const post = (url: string, body: unknown): Promise<Response> =>
    hostFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  switch (verb ?? "") {
    case "start": {
      const caller = detectCaller(systemCallerDeps);
      const assistant = process.env["RELAY_ASSISTANT"]?.trim();
      if (caller === null && (assistant === undefined || assistant === ""))
        throw new Error(
          "canvas start: run this from an omp session (no omp session file found among this command's ancestors)",
        );
      const body = {
        ...(slug === undefined ? {} : { slug }),
        ...(title === undefined ? {} : { title }),
        ...(prompt === undefined ? {} : { prompt }),
        caller:
          caller === null
            ? { assistant }
            : {
                sessionFile: caller.sessionFile,
                chatFile: caller.chatFile,
                ...(caller.assistant === undefined ? {} : { assistant: caller.assistant }),
              },
      };
      const room = CanvasStartReply.parse(await hostJson(await post(base, body), "canvas start"));
      console.log(
        `${room.created ? "Started" : "Rejoined"} a live canvas on "${room.board}" (board ${room.slug}, room ${room.roomId}) as ${room.agent.name}.`,
      );
      console.log(
        `Isaac got a Join card in this chat. Your canvas self (${room.agent.name}, with this chat as context) runs the room on its own; each canvas turn and the wrap-up summary come back to this chat as canvas rows, nothing for you to do until then. End it early with: relay-linux canvas end ${room.slug}`,
      );
      return;
    }
    case "join":
    case "act":
    case "leave": {
      if (slug === undefined) throw new Error(`canvas ${verb}: missing <slug>`);
      const name = options.as?.trim() ?? "";
      const room = `${base}/${encodeURIComponent(slug)}`;
      const rest = positionals.slice(2);
      const readScript = async (): Promise<string> =>
        rest.length === 0 || rest[0] === "-" ? await Bun.stdin.text() : rest.join(" ");
      const report = (who: string, board: string, result: z.infer<typeof CanvasActReply>): void => {
        console.log(
          `${who}: ran ${String(result.ran)} action${result.ran === 1 ? "" : "s"}${result.said.length > 0 ? `, said ${String(result.said.length)} line${result.said.length === 1 ? "" : "s"}` : ""} on "${board}"${options.handoff === undefined ? "" : `; handoff ${options.handoff} landed, the canvas self confirms it in the room`}.`,
        );
        for (const line of result.skipped) console.log(`skipped: ${line}`);
      };
      if (verb === "act" && name === "") {
        // No --as: the room's canvas self, i.e. the chat that started the room acting as itself.
        const result = CanvasActReply.parse(
          await hostJson(
            await post(`${room}/self/act`, {
              script: await readScript(),
              ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
            }),
            "canvas act",
          ),
        );
        report("canvas self", slug, result);
        return;
      }
      if (name === "")
        throw new Error(`canvas ${verb}: missing --as <Name> (the name your cursor shows)`);
      const session =
        verb !== "join" || options.session === undefined
          ? undefined
          : options.session === "me"
            ? ownSessionRef("canvas join --session me")
            : options.session;
      const joined = CanvasJoinReply.parse(
        await hostJson(
          await post(`${room}/participants`, {
            name,
            ...(prompt === undefined || verb !== "join" ? {} : { purpose: prompt }),
            ...(options.color === undefined ? {} : { color: options.color }),
            ...(session === undefined ? {} : { session }),
          }),
          `canvas ${verb}`,
        ),
      );
      const me = joined.participant;
      const leave = async (): Promise<void> => {
        await hostJson(
          await post(`${room}/participants/${encodeURIComponent(me.id)}/leave`, {}),
          "canvas leave",
        );
        console.log(`${me.name} left "${joined.board}".`);
      };
      if (verb === "leave") {
        await leave();
        return;
      }
      if (verb === "join") {
        const others = joined.participants.filter((p) => p.id !== me.id).map((p) => p.name);
        console.log(
          `${joined.created ? "Joined" : "Already in"} "${joined.board}" (board ${joined.slug}) as ${me.name} (${me.color})${session === undefined ? "" : `, a worker: handoffs to ${me.name} reach session ${session}`}, next to ${[joined.agent.name, ...others].join(", ")}.`,
        );
        console.log(
          `Read the board: relay-linux canvas show ${joined.slug}. Act: relay-linux canvas act ${joined.slug} --as "${me.name}" with action lines on stdin (skill://canvas section 8). Leave: relay-linux canvas leave ${joined.slug} --as "${me.name}".`,
        );
        return;
      }
      const result = CanvasActReply.parse(
        await hostJson(
          await post(`${room}/participants/${encodeURIComponent(me.id)}/act`, {
            script: await readScript(),
            ...(options.handoff === undefined ? {} : { handoff: options.handoff }),
          }),
          "canvas act",
        ),
      );
      report(me.name, joined.board, result);
      if (options.leave) await leave();
      return;
    }
    case "show": {
      if (slug === undefined) throw new Error("canvas show: missing <slug>");
      if (options.history || options.since !== undefined) {
        const query = options.since === undefined ? "" : `?since=${encodeURIComponent(options.since)}`;
        const reply = CanvasHistoryReply.parse(
          await hostJson(await hostFetch(`${base}/${encodeURIComponent(slug)}/history${query}`), "canvas show --history"),
        );
        if (reply.entries.length === 0) console.log(`no changes recorded on ${slug}${options.since === undefined ? "" : ` since ${options.since}`}`);
        for (const line of reply.summary) console.log(line);
        if (reply.entries.length > 0) console.log("", "entries (oldest first):");
        for (const entry of reply.entries) console.log(describeEntry(entry));
        return;
      }
      console.log(
        JSON.stringify(
          await hostJson(await hostFetch(`${base}/${encodeURIComponent(slug)}`), "canvas show"),
          null,
          2,
        ),
      );
      return;
    }
    case "restore": {
      const id = positionals[2];
      if (slug === undefined || id === undefined) throw new Error("canvas restore: usage: canvas restore <slug> <id> [--as <Name>]");
      const result = z
        .object({ restored: z.string() })
        .parse(await hostJson(await post(`${base}/${encodeURIComponent(slug)}/restore`, { id, ...(options.as === undefined ? {} : { as: options.as }) }), "canvas restore"));
      console.log(`restored ${result.restored} on ${slug}`);
      return;
    }
    case "list": {
      const reply = await hostJson(await hostFetch(base), "canvas list");
      const { rooms } = CanvasRoomsReply.parse(reply);
      const participants =
        z.object({ participants: z.record(z.array(ParticipantReply)).optional() }).parse(reply)
          .participants ?? {};
      if (rooms.length === 0) console.log("no canvas rooms");
      for (const room of rooms) {
        const agents = (participants[room.id] ?? []).map((p) => p.name);
        console.log(
          `${room.slug}  ${room.live ? "live" : "ended"}  "${room.board}"  ${room.agent.name}${agents.length > 0 ? ` + ${agents.join(", ")}` : ""}  chat ${room.chat.title ?? room.chat.sessionId ?? "-"}${room.humans.length > 0 ? `  here: ${room.humans.join(", ")}` : ""}`,
        );
      }
      return;
    }
    case "end": {
      const { rooms } = CanvasRoomsReply.parse(await hostJson(await hostFetch(base), "canvas end"));
      const live = rooms.filter((room) => room.live);
      let room = slug === undefined ? undefined : live.find((candidate) => candidate.slug === slug);
      if (slug === undefined) {
        // This chat's room: omp names a transcript `<time>_<session id>.jsonl`; else the only live room.
        const chatFile = detectCaller(systemCallerDeps)?.chatFile;
        const sessionId =
          chatFile === undefined ? undefined : basename(chatFile, ".jsonl").split("_").at(-1);
        room =
          live.find(
            (candidate) => sessionId !== undefined && candidate.chat.sessionId === sessionId,
          ) ?? (live.length === 1 ? live[0] : undefined);
        if (room === undefined)
          throw new Error(
            live.length === 0
              ? "canvas end: no live canvas session"
              : `canvas end: several live sessions, name one: ${live.map((r) => r.slug).join(", ")}`,
          );
      }
      if (room === undefined)
        throw new Error(`canvas end: no live canvas session on ${slug ?? ""}`);
      const { summary } = z
        .object({ summary: z.string() })
        .parse(
          await hostJson(
            await post(`${base}/${encodeURIComponent(room.id)}/end`, {}),
            "canvas end",
          ),
        );
      console.log(`Wrapped up "${room.board}". Summary (also posted to the chat): ${summary}`);
      return;
    }
    default:
      throw new Error(`canvas: expected start, join, act, show, leave, list or end\n\n${USAGE}`);
  }
}

const SkillSourceReply = z.object({ label: z.string(), dir: z.string(), file: z.string() });
const SkillRowReply = z.object({
  name: z.string(),
  description: z.string(),
  source: SkillSourceReply,
  also: z.array(SkillSourceReply),
  usedBy: z.array(z.string()),
  disabled: z.boolean(),
  lastUsedAt: z.number().nullable(),
  uses: z.number().nullable(),
});
const SkillDetailReply = SkillRowReply.extend({
  files: z.array(z.object({ path: z.string(), size: z.number() })),
  stats: z
    .object({
      uses30d: z.number(),
      byAgent: z.array(z.object({ agent: z.string(), owner: z.string().nullable(), uses: z.number() })),
    })
    .nullable(),
});
const SkillEditReply = z.object({
  dirty: z.boolean(),
  saved: z.boolean(),
  suggestion: z.string().optional(),
  error: z.string().optional(),
});

/** `skills list|show|edit|reply|save|leave`: talks to the running host's loopback `/skills`. */
async function skillsCommand(
  positionals: string[],
  options: {
    json: boolean;
    as: string | undefined;
    color: string | undefined;
    find: string | undefined;
    replace: string | undefined;
    after: string | undefined;
    insert: string | undefined;
    thread: string | undefined;
    file: string | undefined;
    stdin: boolean;
    save: boolean;
    force: boolean;
    resolve: boolean;
  },
): Promise<void> {
  const [verb, name] = positionals;
  const base = `${hostUrl()}/skills`;
  const post = (url: string, body: unknown): Promise<Response> =>
    hostFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const skill = (): string => {
    if (name === undefined) throw new Error(`skills ${verb ?? ""}: missing <name>`);
    return `${base}/${encodeURIComponent(name)}`;
  };
  const when = (at: number | null): string =>
    at === null ? "never used" : `last used ${new Date(at).toISOString()}`;
  const agent = (): string => {
    const as = options.as?.trim() ?? "";
    if (as === "") throw new Error(`skills ${verb ?? ""}: missing --as <Name> (the name your caret shows)`);
    return as;
  };
  switch (verb ?? "") {
    case "list": {
      const reply = await hostJson(await hostFetch(base), "skills list");
      if (options.json) {
        console.log(JSON.stringify(reply, null, 2));
        return;
      }
      const { skills } = z.object({ skills: z.array(SkillRowReply) }).parse(reply);
      if (skills.length === 0) console.log("no skills");
      for (const row of skills) {
        console.log(
          `${row.name}  ${row.source.label}${row.also.length > 0 ? ` +${String(row.also.length)}` : ""}  ${row.disabled ? "disabled" : `used by ${row.usedBy.join(", ") || "nobody"}`}  ${row.uses === null ? "" : `${String(row.uses)} uses, `}${when(row.lastUsedAt)}`,
        );
      }
      return;
    }
    case "show": {
      const reply = await hostJson(await hostFetch(skill()), "skills show");
      if (options.json) {
        console.log(JSON.stringify(reply, null, 2));
        return;
      }
      const detail = SkillDetailReply.parse(reply);
      console.log(`${detail.name}${detail.disabled ? " (disabled)" : ""}: ${detail.description}`);
      console.log(`file: ${detail.source.file} (${detail.source.label})`);
      for (const copy of detail.also) console.log(`also: ${copy.file} (${copy.label})`);
      console.log(`used by: ${detail.usedBy.join(", ") || "nobody"}`);
      console.log(`${when(detail.lastUsedAt)}${detail.stats === null ? "" : `, ${String(detail.stats.uses30d)} uses in 30 days`}`);
      for (const row of detail.stats?.byAgent ?? []) console.log(`  ${row.agent}${row.owner === null ? "" : ` for ${row.owner}`}: ${String(row.uses)}`);
      console.log(`files: ${detail.files.map((file) => file.path).join(", ")}`);
      return;
    }
    case "edit": {
      const url = skill();
      const as = agent();
      const sources = [options.find !== undefined, options.after !== undefined, options.file !== undefined, options.stdin && options.after === undefined].filter(Boolean).length;
      if (
        sources !== 1 ||
        (options.find !== undefined) !== (options.replace !== undefined) ||
        (options.after !== undefined && (options.insert !== undefined) === options.stdin)
      )
        throw new Error(
          "skills edit: give --find <text> --replace <text>, --after <text> with --insert <markdown> or --stdin, --file <markdown file>, or --stdin",
        );
      const stdin = options.stdin ? await Bun.stdin.text() : undefined;
      const markdown =
        options.file !== undefined ? await Bun.file(options.file).text() : options.after === undefined ? stdin : undefined;
      const change =
        options.after !== undefined
          ? { after: options.after, insert: options.insert ?? stdin }
          : markdown === undefined
            ? { find: options.find, replace: options.replace }
            : { markdown };
      const result = SkillEditReply.parse(
        await hostJson(
          await post(`${url}/edit`, {
            as,
            ...(options.color === undefined ? {} : { color: options.color }),
            ...(options.thread === undefined ? {} : { thread: options.thread }),
            ...change,
            ...(options.save ? { save: true } : {}),
          }),
          "skills edit",
        ),
      );
      console.log(
        result.suggestion !== undefined
          ? `${as} suggested a change to ${name ?? ""} in thread ${options.thread ?? ""}: Isaac accepts or rejects it in the editor.`
          : `${as} edited ${name ?? ""}: ${result.saved ? "saved to SKILL.md" : result.error === "changed-on-disk" ? "not saved, SKILL.md changed on disk (relay-linux skills save --force overwrites it)" : result.dirty ? "unsaved (relay-linux skills save writes it)" : "no change to SKILL.md"}.`,
      );
      return;
    }
    case "reply": {
      const url = skill();
      const as = agent();
      const [, , thread = options.thread, ...words] = positionals;
      if (thread === undefined || thread === "") throw new Error("skills reply: missing <thread>");
      const given = words.join(" ").trim();
      const text = (given === "-" || (given === "" && options.stdin) ? await Bun.stdin.text() : given).trim();
      if (text === "") throw new Error("skills reply: missing the text (or - to read it from stdin)");
      await hostJson(
        await post(`${url}/reply`, {
          as,
          thread,
          text,
          ...(options.color === undefined ? {} : { color: options.color }),
          ...(options.resolve ? { resolve: true } : {}),
        }),
        "skills reply",
      );
      console.log(`${as} replied in ${name ?? ""} thread ${thread}${options.resolve ? " and resolved it" : ""}.`);
      return;
    }
    case "save": {
      const response = await post(`${skill()}/save`, options.force ? { force: true } : {});
      if (response.status === 409) {
        console.error(
          `skills save: ${name ?? ""}'s SKILL.md changed on disk since it was opened; --force overwrites it`,
        );
        process.exit(1);
      }
      const { savedAt } = z
        .object({ savedAt: z.number() })
        .parse(await hostJson(response, "skills save"));
      console.log(`saved ${name ?? ""} at ${new Date(savedAt).toISOString()}`);
      return;
    }
    case "leave": {
      await hostJson(await post(`${skill()}/leave`, { as: agent() }), "skills leave");
      console.log(`${agent()} left ${name ?? ""}.`);
      return;
    }
    default:
      throw new Error(`skills: expected list, show, edit, reply, save or leave\n\n${USAGE}`);
  }
}

/** `react <emoji> | --clear`: the running host puts assistant `agent`'s reaction on one of Isaac's bubbles in its thread. */
async function react(
  agent: string | undefined,
  positionals: string[],
  message: string | undefined,
  clear: boolean,
): Promise<void> {
  const id = agent ?? process.env["RELAY_ASSISTANT"];
  if (id === undefined || id === "")
    throw new Error("react: missing --agent <id> (or $RELAY_ASSISTANT)");
  const emoji = positionals[0];
  if (!clear && emoji === undefined) throw new Error("react: missing <emoji> (or --clear)");
  const response = await hostFetch(`${hostUrl()}/reactions/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: id,
      ...(clear ? { clear } : { emoji }),
      ...(message === undefined ? {} : { message }),
    }),
  });
  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }
  const answer = (await response.json()) as { message: string; emoji: string | null };
  console.log(
    answer.emoji === null
      ? `cleared ${id}'s reaction on ${answer.message}`
      : `${id} reacted ${answer.emoji} to ${answer.message}`,
  );
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
      response = await hostFetch(base);
      break;
    case "get":
      response = await hostFetch(target());
      break;
    case "put":
      response = await hostFetch(target(), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: await Bun.stdin.text(),
      });
      break;
    case "ops":
      response = await hostFetch(`${target()}/ops`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await Bun.stdin.text(),
      });
      break;
    case "rm":
      response = await hostFetch(target(), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
      });
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
      port: { type: "string" },
      name: { type: "string" },
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
      session: { type: "string" },
      handoff: { type: "string" },
      leave: { type: "boolean", default: false },
      work: { type: "boolean", default: false },
      history: { type: "boolean", default: false },
      since: { type: "string" },
      id: { type: "string" },
      scope: { type: "string" },
      model: { type: "string" },
      voice: { type: "string" },
      "live-voice": { type: "string" },
      unset: { type: "string", multiple: true, default: [] },
      start: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      find: { type: "string" },
      replace: { type: "string" },
      after: { type: "string" },
      insert: { type: "string" },
      resolve: { type: "boolean", default: false },
      file: { type: "string" },
      stdin: { type: "boolean", default: false },
      save: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      thread: { type: "string" },
      from: { type: "string" },
      question: { type: "string" },
      options: { type: "string" },
      default: { type: "string" },
      answer: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      device: { type: "string" },
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help) {
    console.log(USAGE);
    return;
  }
  switch (command) {
    case "serve": {
      const config = loadHostConfig();
      const portText = values.port ?? String(config?.port ?? 0);
      const port = Number.parseInt(portText, 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error(`invalid --port ${portText}`);
      const vncPort = Number.parseInt(values["vnc-port"], 10);
      if (!Number.isInteger(vncPort) || vncPort < 1 || vncPort > 65535)
        throw new Error(`invalid --vnc-port ${values["vnc-port"]}`);
      const name = values.name ?? config?.name ?? hostname();
      setHuman(resolveHuman(config, name));
      // The Eva boards dir exists only on the owner's Mac; other hosts keep canvases under Relay's own support dir.
      const evaCanvases = join(homedir(), "Library", "Application Support", "EvaOS", "canvases");
      const defaultCanvases =
        process.platform !== "darwin"
          ? null
          : config === null || existsSync(evaCanvases)
            ? evaCanvases
            : join(homedir(), "Library", "Application Support", "Relay", "canvases");
      serve(
        port,
        name,
        values["agent-home"] ?? config?.agentHome ?? process.env["HOME"] ?? null,
        !values["no-clipboard"],
        values.boards ?? process.env["RELAY_BOARDS_DIR"] ?? null,
        vncPort,
        values.canvases ?? defaultCanvases,
        config,
      );
      return;
    }
    case "catchup": {
      if (positionals[1] !== "bounce")
        throw new Error("catchup: try `catchup bounce <id> <reason>`");
      await catchupBounce(values.agent ?? process.env["RELAY_ASSISTANT"], positionals.slice(2));
      return;
    }
    case "asks": {
      const verb = positionals[1];
      const agent = values.agent ?? process.env["RELAY_ASSISTANT"];
      if (verb === "list") await asksList(agent, values.json);
      else if (verb === "resolve") await asksResolve(agent, positionals.slice(2), values.answer);
      else if (verb === "get") await asksGet(positionals[2], values.json);
      else if (verb === "add")
        await asksAdd({
          thread: values.thread ?? process.env["RELAY_ASSISTANT"],
          from: values.from,
          session: values.session,
          question: values.question,
          options: values.options,
          default: values.default,
        });
      else throw new Error("asks: try `asks list`, `asks add`, `asks get <id>` or `asks resolve <id>...`");
      return;
    }
    case "eta": {
      const agentHome = values["agent-home"] ?? appAgentHome();
      const report = await runEtaReport(
        new RunHistory(join(relayConfigDir(), "eta-history.json"), sessionRoots(), () => sessionSources(agentHome)),
        new CalibrationLog(join(relayConfigDir(), "eta-calibration.jsonl")),
      );
      console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
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
      if (verb === "say") {
        await assistantSay(values.agent, positionals.slice(2));
        return;
      }
      if (verb === "consult") {
        await assistantConsult({ agent: values.agent, title: values.title, work: values.work }, positionals.slice(2));
        return;
      }
      if (verb === undefined) throw new Error("assistant: try say, consult, list, create, set or retire");
      await assistantAdminCommand(verb, {
        agent: values.agent,
        id: values.id,
        title: values.title,
        scope: values.scope,
        model: values.model,
        voice: values.voice,
        liveVoice: values["live-voice"],
        unset: values.unset,
        start: values.start,
      });
      return;
    }
    case "canvas":
      await canvasCommand(positionals.slice(1), {
        title: values.title,
        prompt: values.prompt,
        as: values.as,
        color: values.color,
        session: values.session,
        handoff: values.handoff,
        leave: values.leave,
        history: values.history,
        since: values.since,
      });
      return;
    case "skills":
      await skillsCommand(positionals.slice(1), {
        json: values.json,
        as: values.as,
        color: values.color,
        find: values.find,
        replace: values.replace,
        after: values.after,
        insert: values.insert,
        thread: values.thread,
        file: values.file,
        stdin: values.stdin,
        save: values.save,
        force: values.force,
        resolve: values.resolve,
      });
      return;
    case "react":
      await react(values.agent, positionals.slice(1), values.message, values.clear);
      return;
    case "rooms":
      await roomsCommand(positionals[1], positionals.slice(2), values.device);
      return;
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
