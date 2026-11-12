/**
 * Wires the pure pieces (SessionMachine, CommandQueue, Discovery, RelaySocket, identity) into the
 * live seams the rest of the app calls: `sendInput`/`sendCommand`/`getClientTime`/`connection`,
 * plus `@/state/actions` and `@/state/connection`. This is the only module in the package that
 * touches React Native runtime APIs (WebSocket, AppState, SecureStore, Zeroconf).
 */
import { useEffect } from "react";
import { AppState, type AppStateStatus, type NativeEventSubscription } from "react-native";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import {
  encode,
  parseServerMessage,
  BOOKMARKS_FEATURE,
  ROOMS_CHAT_FEATURE,
  ROOMS_FEATURE,
  reactionExcerpt,
  WS_PATH,
  type ArtifactAction,
  type CatchUpSignal,
  type ClientMessage,
  type Command,
  type FeedAction,
  type FeedItem,
  type InputEvent,
  type MeetingsOp,
  type MeetingsResult,
  type ReviewsOp,
  type ReviewsResult,
  type RoomsCmd,
  type RoomsResult,
  type StudioOp,
  type StudioResult,
} from "@relay/protocol";
import { useConnectionStore } from "@/state/connection";
import { useAgentsStore } from "@/state/agents";
import { useDropsStore } from "@/state/drops";
import { useVncStore } from "@/state/vnc";
import { useBoardsStore } from "@/state/boards";
import { useGateStore } from "@/state/gate";
import { useUsageStore } from "@/state/usage";
import { useActivityStore } from "@/state/activity";
import { useCatchUpStore } from "@/state/catchup";
import { useFeedStore } from "@/state/feed";
import { useAssistantStore } from "@/state/assistant";
import { useReactionsStore } from "@/state/reactions";
import { isTurnKey, useBookmarksStore } from "@/state/bookmarks";
import { useArtifactsStore } from "@/state/artifacts";
import { useCanvasStore } from "@/state/canvas";
import { useStudioStore } from "@/state/studio";
import { useRoomsStore } from "@/state/rooms";
import { useReviewsStore } from "@/state/reviews";
import { useMeetingsStore } from "@/state/meetings";
import { callIsLive, useCallStore } from "@/state/call";
import { createCallFrameRouter } from "@/call/frames";
import { callStats } from "@/call/stats";
import { VoiceCall } from "../../modules/voice-call";
import { configureLiveCall } from "@/call/liveConfig";
import { setActions } from "@/state/actions";
import { useSettingsStore } from "@/state/settings";
import { createAgentFrameRouter } from "./agents";
import { createDropFrameRouter } from "./drops";
import { createVncFrameRouter } from "./vnc";
import { createBoardFrameRouter } from "./boards";
import { createGateFrameRouter } from "./gate";
import { createUsageFrameRouter } from "./usage";
import { createActivityFrameRouter } from "./activity";
import { createCatchUpFrameRouter } from "./catchup";
import { createFeedFrameRouter } from "./feed";
import { createAssistantFrameRouter } from "./assistant";
import { createReactionFrameRouter } from "./reactions";
import { createBookmarkFrameRouter } from "./bookmarks";
import { createArtifactFrameRouter, PendingActs, type ActResult } from "./artifacts";
import { createStudioFrameRouter, PendingStudio } from "./studio";
import { createRoomsFrameRouter, PendingRooms } from "./rooms";
import { createReviewsFrameRouter, PendingReviews } from "./reviews";
import { createMeetingsFrameRouter, PendingMeetings } from "./meetings";
import { createQueryClient, createQueryFrameRouter, PendingQueries } from "./query";
import { beginCanvasAccess, canvasWelcomeFrames, createCanvasFrameRouter } from "./canvas";
import { allowedTarget, mayDiscover, parseOnlyHost } from "./only-host";
import * as identity from "./identity";
import { Discovery, type DiscoveredService } from "./discovery";
import { NO_HOSTS, removeHost, upsertHost, type PairedHosts } from "./hosts";
import { parseManualHost } from "./manual-host";
import { RelaySocket } from "./socket";
import { SessionMachine, type Effect } from "./session";
import { CommandQueue, type CommandReport } from "./commands";
import { debug, warn } from "./log";
import { withdrawNotification } from "@/inbox/withdraw";
import { hostTakesRenderReports, renderFailedFrame, type RenderReport } from "@/agents/renderReport";

/** `EXPO_PUBLIC_RELAY_ONLY_HOST` pins a test bundle to one host; unset (every real build) changes nothing. */
const ONLY_HOST = parseOnlyHost(process.env.EXPO_PUBLIC_RELAY_ONLY_HOST);

let started = false;
let deviceId = "";
let hosts: PairedHosts = NO_HOSTS;
/**
 * Id of the host the session aims at: a saved host, or one being paired from the host picker.
 * `null` only with no saved hosts, when discovery takes the first host it finds.
 */
let target: string | null = null;
let currentCandidate: DiscoveredService | null = null;
let machine: SessionMachine | null = null;
let wasActive = true;
let appStateSubscription: NativeEventSubscription | null = null;
let retryTimer: number | undefined;
/**
 * `host:port` the socket was last opened with (IPv6 bracketed), the origin for `/drops/...` blob
 * fetches and the `/vnc` bridge. Only meaningful while `status === "connected"`; a later connect
 * overwrites it.
 */
let hostAuthority: string | null = null;
/** Whether the connected host's `welcome.features` has `render.report`; set on every welcome. */
let hostTakesRenders = false;
/**
 * The assistant whose thread is on screen, if any. The host treats a socket as following an
 * agent's thread (live snapshots, no push to this phone for that agent) for five minutes after
 * each `assistant.get`, so while the screen shows the driver re-asks on every welcome and every
 * `ASSISTANT_FOLLOW_MS`.
 */
let watchedAssistant: string | null = null;
/** How many of the watched thread's newest rows the host sends (`assistant.get` `rows`). */
let watchedRows = 0;
let assistantFollowTimer: number | undefined;
const ASSISTANT_FOLLOW_MS = 4 * 60_000;
/**
 * Reaction threads with a screen open on them, counted per screen: the driver asks for each one's
 * reactions again on every welcome, since the host pushes snapshots only to connected devices.
 */
const reactionThreads = new Map<string, number>();
/** Artifact threads with a screen or sheet open on them, counted like `reactionThreads`. */
const artifactThreads = new Map<string, number>();
const pendingActs = new PendingActs();
const pendingStudio = new PendingStudio();
const pendingRooms = new PendingRooms();
const pendingReviews = new PendingReviews();
const pendingMeetings = new PendingMeetings();
const pendingQueries = new PendingQueries();
/** Live dashboard tiles' Query statements; only reachable on a host whose welcome offers "query". */
export const liveQuery = createQueryClient(pendingQueries, (rid, tool, args) => {
  if (useConnectionStore.getState().status !== "connected" || !useBoardsStore.getState().queries)
    return false;
  socket.send(encode({ t: "query.req", rid, tool, args }));
  return true;
});

const commandQueue = new CommandQueue();
const socket = new RelaySocket();
/** Image fetches sent and not yet answered; the host's `agent.image` (or a new welcome) clears them. */
const imagesInFlight = new Set<string>();

function imageKey(sessionId: string, id: string): string {
  return `${sessionId}/${id}`;
}

const routeAgentFrame = createAgentFrameRouter(useAgentsStore.getState(), (message) =>
  socket.send(encode(message)),
);
const routeDropFrame = createDropFrameRouter(useDropsStore.getState());
const routeVncFrame = createVncFrameRouter(useVncStore.getState(), () => hostAuthority);
const routeBoardFrame = createBoardFrameRouter(useBoardsStore.getState());
const routeGateFrame = createGateFrameRouter(useGateStore.getState());
const routeUsageFrame = createUsageFrameRouter(useUsageStore.getState());
const routeActivityFrame = createActivityFrameRouter(useActivityStore.getState());
const routeCatchUpFrame = createCatchUpFrameRouter(useCatchUpStore.getState());
const routeFeedFrame = createFeedFrameRouter(useFeedStore.getState());
const routeAssistantFrame = createAssistantFrameRouter(useAssistantStore.getState());
const routeReactionFrame = createReactionFrameRouter(useReactionsStore.getState());
const routeBookmarkFrame = createBookmarkFrameRouter(useBookmarksStore.getState(), (thread, key) => {
  socket.send(encode({ t: "bookmark.set", thread, message: key, on: true }));
});
const routeArtifactFrame = createArtifactFrameRouter(useArtifactsStore.getState(), pendingActs);
const routeCanvasFrame = createCanvasFrameRouter(useCanvasStore.getState(), () => hostAuthority);
const routeStudioFrame = createStudioFrameRouter(useStudioStore.getState(), pendingStudio);
const routeRoomsFrame = createRoomsFrameRouter(useRoomsStore.getState(), pendingRooms);
const routeReviewsFrame = createReviewsFrameRouter(useReviewsStore.getState(), pendingReviews);
const routeMeetingsFrame = createMeetingsFrameRouter(useMeetingsStore.getState(), pendingMeetings);
const routeQueryFrame = createQueryFrameRouter(
  useBoardsStore.getState().setQueries,
  pendingQueries,
);
const routeCallFrame = createCallFrameRouter(
  { update: useCallStore.getState().update, current: () => useCallStore.getState().call },
  {
    play: (pcm) => {
      callStats.audioIn += 1;
      VoiceCall?.play(pcm);
    },
    flush: () => {
      VoiceCall?.flush();
    },
  },
);
const discovery = new Discovery({
  onCandidate: (service) => {
    currentCandidate = service;
    const pairedSecretHex =
      hosts.hosts.find((host) => host.id === (target ?? service.name))?.secretHex ?? null;
    void dispatch({ type: "serviceFound", service, pairedSecretHex });
  },
  onServices: (services) => {
    useConnectionStore.getState().set({ discovered: services });
  },
});

socket.onOpen = () => {
  void dispatch({ type: "socketOpen" });
};
socket.onClose = () => {
  // What was held for a socket that is gone: the next welcome asks for everything again.
  latestFrames.clear();
  // The host hangs up a call with its socket; say so here rather than leave the screen listening.
  const call = useCallStore.getState().call;
  if (call !== null && call.state !== "ended")
    useCallStore
      .getState()
      .update(call.id, { state: "ended", error: "Lost the connection to your Mac" });
  // The next welcome says again whether this host answers queries; nothing in flight will be.
  useBoardsStore.getState().setQueries(false);
  // ... and whether it keeps bookmarks; what it last said stays shown, but nothing can be sent.
  useBookmarksStore.getState().setHostUp(false);
  pendingQueries.cancelAll();
  void dispatch({ type: "socketClosed" });
};
socket.onError = (error) => {
  warn("socket", "error", error);
};
/**
 * Whole-state frames the host sends again on every change, of which only the newest per thread or
 * room is ever drawn: an assistant's thread (every 150 ms while a reply streams), a thread's
 * artifacts (2,000 items, 1 MB) and the rooms (each changed room whole, up to 2 MB, up to 4 times
 * a second while it talks; the list supersedes every room held before it). Decoding and drawing
 * one took the JS thread longer than the gap to the next, so the frames queued behind it in native
 * memory without bound and the app grew past 2 GB while Isaac chatted. Such a frame is held raw (a
 * newer one replaces it, keeping arrival order) and decoded once the frames already queued have
 * been taken, so a burst costs one decode. A room frame whose id does not lead is decoded at once.
 */
const LATEST_ONLY = /^\{"t":"(?:(assistant\.snapshot|artifacts\.snapshot)","(?:agent|thread)":"([^"]*)"|(rooms\.room)","room":\{"id":"([^"]*)"|(rooms\.state)")/;
const latestFrames = new Map<string, string>();
let latestTimer: number | null = null;

function takeLatestFrames(): void {
  latestTimer = null;
  const frames = [...latestFrames.values()];
  latestFrames.clear();
  for (const frame of frames) handleFrame(frame);
}

socket.onMessage = (data) => {
  const latest = LATEST_ONLY.exec(data.slice(0, 200));
  if (latest === null) {
    handleFrame(data);
    return;
  }
  const kind = latest[1] ?? latest[3] ?? latest[5] ?? "";
  // The host follows a thread for 5 minutes after the screen last asked; only the screen showing it draws it.
  if (kind === "assistant.snapshot" && latest[2] !== watchedAssistant) return;
  if (kind === "rooms.state") for (const key of [...latestFrames.keys()]) if (key.startsWith("rooms.room:")) latestFrames.delete(key);
  const key = `${kind}:${latest[2] ?? latest[4] ?? ""}`;
  latestFrames.delete(key);
  latestFrames.set(key, data);
  latestTimer ??= setTimeout(takeLatestFrames, 0);
};

function handleFrame(data: string): void {
  const result = parseServerMessage(data);
  if (!result.ok) {
    warn("socket", "malformed server message", result.error);
    return;
  }
  const message = result.value;
  if (message.t === "ack") {
    commandQueue.onAck(message.id);
    return;
  }
  if (message.t === "nack") {
    commandQueue.onNack(message.id, message.error);
    return;
  }
  if (message.t === "welcome") {
    commandQueue.onReconnect((m) => socket.send(encode(m)));
    hostTakesRenders = hostTakesRenderReports(message.features);
    imagesInFlight.clear();
    // The host owns the drop history; the phone never trusts its copy across a (re)connection.
    socket.send(encode({ t: "drop.list" }));
    // Dashboards stream live; the host forgets the subscription with the socket.
    socket.send(encode({ t: "board.subscribe" }));
    // The habit gate may have locked or unlocked while the phone was away.
    socket.send(encode({ t: "gate.get" }));
    // Plan usage moves while the phone is away; the host refreshes it when its copy is over a minute old.
    socket.send(encode({ t: "usage.get" }));
    // What agents run on the host moved while away; the answer goes to every device.
    socket.send(encode({ t: "activity.get" }));
    // The Catch Up feed and its read state may have changed while away.
    socket.send(encode({ t: "catchup.list" }));
    // The Assistants list comes from the host's registry and live sessions, which may have changed while away.
    socket.send(encode({ t: "assistant.agents" }));
    // A thread is only fetched while its screen is showing; the screen asks again on focus.
    if (watchedAssistant !== null)
      socket.send(encode({ t: "assistant.get", agent: watchedAssistant, rows: watchedRows }));
    // Reactions may have changed on another device while this one was away.
    for (const thread of reactionThreads.keys()) {
      socket.send(encode({ t: "reactions.get", thread }));
      if (message.features?.includes(BOOKMARKS_FEATURE) === true)
        socket.send(encode({ t: "bookmarks.get", thread }));
    }
    for (const thread of artifactThreads.keys())
      socket.send(encode({ t: "artifacts.get", thread }));
    // Live canvas rooms come and go while away, and a restarted host counts revs from zero again and
    // forgot its tokens; an open the socket dropped before its answer asks again.
    useCanvasStore.getState().reconnected();
    for (const frame of canvasWelcomeFrames(useCanvasStore.getState().access))
      socket.send(encode(frame));
    // Studio jobs ran on while away; the host sends the whole state again.
    socket.send(encode({ t: "studio.list" }));
    // Rooms ran on while away; only a host that relays them is asked (chat rooms too when it relays them).
    if (message.features?.includes(ROOMS_FEATURE) === true)
      socket.send(encode({ t: "rooms.get", ...(message.features.includes(ROOMS_CHAT_FEATURE) ? { chat: true } : {}) }));
    // The Reviews queue moved while away; the host answers with its last read at once.
    void sendReviews({ kind: "queue", refresh: false });
    // Recordings started, ended or moved on while away.
    socket.send(encode({ t: "meetings.list" }));
  }
  if (message.t === "agent.image") imagesInFlight.delete(imageKey(message.sessionId, message.id));
  // Answered on the Mac, in the chat or on another device: take its notification off the lock screen.
  if (message.t === "inbox.resolve") {
    withdrawNotification(message.id).catch((error: unknown) => {
      warn("inbox", "withdraw failed", error);
    });
  }
  routeAgentFrame(message);
  routeDropFrame(message);
  routeVncFrame(message);
  routeBoardFrame(message);
  routeGateFrame(message);
  routeUsageFrame(message);
  routeActivityFrame(message);
  routeCatchUpFrame(message);
  routeFeedFrame(message);
  routeReactionFrame(message);
  routeBookmarkFrame(message);
  routeArtifactFrame(message);
  routeCanvasFrame(message);
  routeStudioFrame(message);
  routeRoomsFrame(message);
  routeReviewsFrame(message);
  routeMeetingsFrame(message);
  routeQueryFrame(message);
  routeAssistantFrame(message);
  routeCallFrame(message);
  void dispatch({ type: "server", message });
}

async function dispatch(input: Parameters<SessionMachine["handle"]>[0]): Promise<void> {
  if (machine === null) return;
  const effects = await machine.handle(input, getClientTime());
  await applyEffects(effects);
}

async function applyEffects(effects: Effect[]): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case "connect":
        debug("session", "connect", effect.host, effect.port);
        hostAuthority = `${effect.host.includes(":") ? `[${effect.host}]` : effect.host}:${effect.port}`;
        socket.open(`ws://${hostAuthority}${WS_PATH}`);
        break;
      case "send":
        socket.send(encode(effect.message));
        break;
      case "startDiscovery": {
        // A typed `host:port` target skips Bonjour entirely: hand the machine a synthetic resolved service.
        const manual = target === null ? null : parseManualHost(target);
        if (manual === null) {
          // A pinned bundle never browses: a bad pin connects nowhere instead of to whatever answers.
          if (mayDiscover(ONLY_HOST)) discovery.start(target);
          else if (ONLY_HOST.kind === "invalid")
            useConnectionStore
              .getState()
              .set({ lastError: `EXPO_PUBLIC_RELAY_ONLY_HOST is not host:port: ${ONLY_HOST.raw}` });
        } else {
          discovery.stop();
          currentCandidate = manual;
          void dispatch({
            type: "serviceFound",
            service: manual,
            pairedSecretHex: hosts.hosts.find((host) => host.id === target)?.secretHex ?? null,
          });
        }
        break;
      }
      case "stopDiscovery":
        discovery.stop();
        break;
      case "scheduleRetry":
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void dispatch({ type: "timer" });
        }, effect.ms);
        break;
      case "storeSecret": {
        // With no target (nothing saved yet) the pairing belongs to whichever host discovery found.
        const id = target ?? currentCandidate?.name ?? null;
        if (id === null) break;
        target = id;
        const name =
          hosts.hosts.find((host) => host.id === id)?.name ?? currentCandidate?.name ?? id;
        await persistHosts({
          ...upsertHost(hosts, { id, name, address: hostAuthority ?? "", secretHex: effect.hex }),
          activeId: id,
        });
        break;
      }
      case "forgetSecret":
        // The target host no longer knows this phone: its saved secret is dead.
        if (target !== null) await persistHosts(removeHost(hosts, target));
        break;
      case "storeUpdate": {
        useConnectionStore.getState().set(effect.partial);
        // Keep the saved entry's name and address current with what the host reports on welcome.
        const saved = hosts.hosts.find((host) => host.id === target);
        const mac = effect.partial.mac;
        if (
          saved !== undefined &&
          mac !== undefined &&
          mac !== null &&
          (mac.name !== saved.name || (hostAuthority ?? "") !== saved.address)
        ) {
          await persistHosts(
            upsertHost(hosts, { ...saved, name: mac.name, address: hostAuthority ?? "" }),
          );
        }
        if (effect.partial.status === "connected") syncLiveCallHosts();
        break;
      }
    }
  }
}

/**
 * `Sha256`'s `Uint8Array` may be backed by `ArrayBufferLike` (TS 5.7+ generic typed arrays);
 * `expo-crypto`'s `digest` requires a plain `ArrayBuffer`-backed view, so reallocate to normalize.
 */
function sha256(data: Uint8Array): Promise<ArrayBuffer> {
  return digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(data));
}

/** Saves `next` to Keychain and publishes it, secrets stripped, to `useConnectionStore`. */
async function persistHosts(next: PairedHosts): Promise<void> {
  hosts = next;
  publishHosts();
  await identity.savePairedHosts(next);
  syncLiveCallHosts();
}

/** The live call engine keeps its own copy of the paired hosts, for calls started with no JS (the Action Button). */
function syncLiveCallHosts(): void {
  const connected = useConnectionStore.getState().status === "connected";
  configureLiveCall({
    authority: connected ? hostAuthority : null,
    activeId: target,
    hosts: hosts.hosts,
    deviceId,
    deviceName: useSettingsStore.getState().deviceName,
  });
}

function publishHosts(): void {
  useConnectionStore.getState().set({
    hosts: hosts.hosts.map((host) => ({ id: host.id, name: host.name, address: host.address })),
    activeHostId: target,
  });
}

async function boot(): Promise<void> {
  deviceId = await identity.getDeviceId();
  await identity.importProvisionedHost(deviceId);
  hosts = await identity.loadPairedHosts();
  target = allowedTarget(ONLY_HOST, hosts.activeId);
  publishHosts();
  wasActive = AppState.currentState === "active";
  appStateSubscription = AppState.addEventListener("change", onAppStateChange);
  await resetSession();
}

/** Tears down socket, timers and discovery, then starts a fresh machine aimed at `target`. */
async function resetSession(): Promise<void> {
  currentCandidate = null;
  discovery.stop();
  socket.close();
  clearTimeout(retryTimer);
  retryTimer = undefined;
  useConnectionStore.getState().set({
    status: "idle",
    mac: null,
    macName: null,
    lastError: null,
    pairing: { pinRequired: false, failure: null },
  });
  machine = new SessionMachine({
    sha256,
    deviceId,
    getDeviceName: () => useSettingsStore.getState().deviceName,
  });
  await dispatch({ type: "appActive" });
}

/**
 * Points the session at `id` (or discovery, for `null`). Everything the previous host said goes
 * with it, and commands still waiting for its ack are cancelled rather than replayed on the new one.
 */
async function retarget(id: string | null): Promise<void> {
  target = allowedTarget(ONLY_HOST, id);
  publishHosts();
  commandQueue.cancelAll();
  useAgentsStore.getState().applyWelcome(0, []);
  useDropsStore.getState().setAll([]);
  useBoardsStore.getState().setAll([]);
  useGateStore.getState().set(null);
  useUsageStore.getState().set(null);
  useActivityStore.getState().set([]);
  useCatchUpStore.getState().set(null);
  useFeedStore.getState().set(null);
  useReactionsStore.getState().clear();
  useBookmarksStore.getState().clearHost();
  useArtifactsStore.getState().clear();
  useCanvasStore.getState().clear();
  useStudioStore.getState().clear();
  useRoomsStore.getState().clear();
  useReviewsStore.getState().clear();
  useMeetingsStore.getState().clear();
  pendingActs.cancelAll();
  pendingStudio.cancelAll();
  pendingRooms.cancelAll();
  pendingReviews.cancelAll();
  pendingMeetings.cancelAll();
  pendingQueries.cancelAll();
  useBoardsStore.getState().setQueries(false);
  useVncStore.getState().setAccess({ kind: "idle" });
  await resetSession();
}

/** A saved host connects with its secret; any other id starts pairing with it straight away. */
async function switchHost(id: string): Promise<void> {
  if (allowedTarget(ONLY_HOST, id) !== id) return;
  if (id === target && useConnectionStore.getState().status === "connected") return;
  const saved = hosts.hosts.some((host) => host.id === id);
  if (saved) await persistHosts({ ...hosts, activeId: id });
  await retarget(id);
  if (!saved) await dispatch({ type: "startPairing" });
}

async function forgetHost(id: string): Promise<void> {
  const next = removeHost(hosts, id);
  await persistHosts(next);
  if (id === target) await retarget(next.activeId);
}

/**
 * Backgrounding closes the socket, except during a call: the call keeps the app running (audio
 * background mode) and needs its socket. The deferred close happens when the call ends.
 */
function onAppStateChange(next: AppStateStatus): void {
  // `inactive` is a pass-through (Face ID, Control or Notification Center, the app switcher, a system
  // alert): the app is still on screen and comes back without a reconnect, so only `background` closes.
  if (next === "inactive") return;
  const active = next === "active";
  if (active === wasActive) return;
  if (!active && callIsLive()) return;
  wasActive = active;
  if (active) {
    void dispatch({ type: "appActive" });
    return;
  }
  void dispatch({ type: "appBackground" });
  socket.close();
}

useCallStore.subscribe((store, previous) => {
  const ended =
    (store.call === null || store.call.state === "ended") &&
    previous.call !== null &&
    previous.call.state !== "ended";
  if (ended && AppState.currentState !== "active") onAppStateChange(AppState.currentState);
});

/** Ephemeral like `sendInput`: a call's frames are never queued; the host ends the call with the socket. */
export function sendCall(message: Extract<ClientMessage, { t: `call.${string}` }>): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode(message));
}

/** Ephemeral; no-op unless `status === "connected"`, and never queued. */
export function sendInput(events: InputEvent[]): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "input", events }));
}

/**
 * Screens holding each session subscribed. The host keeps one subscription per session per socket,
 * so two screens showing one session (an assistant's thread and the Agent Inbox on that session)
 * share it: the one that leaves last unsubscribes, whichever order their focus changes land in.
 */
const agentSubscribers = new Map<string, number>();

/**
 * Ephemeral, like `sendInput`: the host drops subscriptions with the socket, so nothing is queued;
 * each subscribe replays the conversation and whatever the session is blocked on. Pair every call
 * with `unsubscribeAgent`.
 */
export function subscribeAgent(sessionId: string): void {
  agentSubscribers.set(sessionId, (agentSubscribers.get(sessionId) ?? 0) + 1);
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "agent.subscribe", sessionId }));
}

export function unsubscribeAgent(sessionId: string): void {
  const holders = (agentSubscribers.get(sessionId) ?? 1) - 1;
  if (holders > 0) {
    agentSubscribers.set(sessionId, holders);
    return;
  }
  agentSubscribers.delete(sessionId);
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "agent.unsubscribe", sessionId }));
}

/** Ephemeral; the answer lands in `useAgentsStore().options[sessionId]`. */
export function requestAgentOptions(sessionId: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "agent.options", sessionId }));
}

/** Ephemeral; the answer lands in `useDropsStore().drops`. Also sent by the driver on every welcome. */
export function requestDrops(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "drop.list" }));
}

/** Ephemeral; the answer lands in `useAssistantStore().agents`. Also sent on every welcome; the host pushes it again when a status or last reply changes. */
export function requestAssistantAgents(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "assistant.agents" }));
}

/** Ephemeral; the answer lands in `useUsageStore().usage`. Also sent on every welcome; the host refreshes when its copy is over a minute old. */
export function requestUsage(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "usage.get" }));
}

/** Asks the host to refetch every account's usage now; `usage.snapshot` follows as the refresh starts and ends. */
export function refreshUsage(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "usage.refresh" }));
}

/** Ephemeral; the answer lands in `useCatchUpStore().items`. Also sent on every welcome. */
export function requestCatchUp(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "catchup.list" }));
}

/** Ephemeral; the answer lands in `useFeedStore().items`. Asked when the Feed screen shows. */
export function requestFeed(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "feed.list" }));
}

/**
 * Isaac liked, saved or skipped a card: shown at once, then appended by the host to the feed's
 * `signals.jsonl` (the next fetch ranks with it). False (nothing sent, nothing shown) while not connected.
 */
export function signalFeed(item: FeedItem, action: FeedAction): boolean {
  if (useConnectionStore.getState().status !== "connected") return false;
  useFeedStore.getState().actLocal(item.id, action);
  socket.send(encode({ t: "feed.signal", id: item.id, action, title: item.title, source: item.source }));
  return true;
}

/**
 * Marks a Catch Up card read or unread: flipped locally at once, then the host's `catchup.snapshot`
 * confirms it (or puts it right). Offline, only the local flip happens; the next welcome's list wins.
 */
export function markCatchUp(id: string, read: boolean): void {
  useCatchUpStore.getState().markLocal(id, read);
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "catchup.mark", id, read }));
}

/**
 * Hands a Catch Up card to assistant `agent` (with Isaac's optional `note`): the host sends it to that
 * thread and marks it read. Shown read and handed at once; false (and nothing changed) while not
 * connected, since only the host can deliver it.
 */
export function handoffCatchUp(id: string, agent: string, note?: string): boolean {
  if (useConnectionStore.getState().status !== "connected") return false;
  useCatchUpStore.getState().markLocal(id, true, agent);
  const trimmed = note?.trim();
  socket.send(
    encode({
      t: "catchup.handoff",
      id,
      agent,
      ...(trimmed === undefined || trimmed === "" ? {} : { note: trimmed }),
    }),
  );
  return true;
}

/**
 * Sends Isaac's note on why a Catch Up card does or does not need him (a `signal` chip, free `text`,
 * or both) for Nova to learn from; the card stays in the deck. The host's `catchup.noted` lands in
 * `useCatchUpStore().noteAnswer`. False (nothing sent) while not connected.
 */
export function noteCatchUp(id: string, signal: CatchUpSignal | undefined, text: string): boolean {
  if (useConnectionStore.getState().status !== "connected") return false;
  socket.send(
    encode({
      t: "catchup.note",
      id,
      text: text.trim(),
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  return true;
}

/**
 * Ephemeral; the answer lands in `useAssistantStore().threads[agent]`. Also marks `agent`'s
 * thread as showing: the driver re-asks on every welcome and every `ASSISTANT_FOLLOW_MS` until
 * `stopAssistant`, keeping the host's follow window open. Sends nothing while not connected (the
 * welcome will). The host sends only the newest `rows` rows, then and on every change: a long
 * thread whole (Nova's: 7,900 rows, 4.3 MB, every 150 ms while a reply streams) took Hermes about
 * 230 ms a frame to decode, which kept the JS thread busy for as long as a reply streamed.
 */
export function requestAssistant(agent: string, rows: number): void {
  watchedAssistant = agent;
  watchedRows = rows;
  clearInterval(assistantFollowTimer);
  assistantFollowTimer = setInterval(() => {
    if (useConnectionStore.getState().status === "connected")
      socket.send(encode({ t: "assistant.get", agent, rows }));
  }, ASSISTANT_FOLLOW_MS);
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "assistant.get", agent, rows }));
}

/**
 * `agent`'s thread left the screen: stop following, so its replies reach this phone as pushes
 * again. A no-op when another agent's thread has already taken over (its focus can land first).
 */
export function stopAssistant(agent: string): void {
  if (watchedAssistant !== agent) return;
  watchedAssistant = null;
  clearInterval(assistantFollowTimer);
  assistantFollowTimer = undefined;
}

/** Ephemeral; the answer (and every later change) lands in `useReactionsStore().threads[thread]`. */
export function getReactions(thread: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "reactions.get", thread }));
  if (useBookmarksStore.getState().hostUp) socket.send(encode({ t: "bookmarks.get", thread }));
}

/**
 * Marks or unmarks turn `key` of `thread`: on the host when it keeps bookmarks (shown at once, then
 * the host's `bookmarks.snapshot` confirms it), else on this phone. False, and nothing changed, for
 * a thread whose bookmarks live on the host while it cannot be reached, or a turn it cannot name.
 */
export function toggleTurnBookmark(thread: string, key: string): boolean {
  const store = useBookmarksStore.getState();
  const onHost = store.host[thread];
  if (onHost === undefined) {
    store.toggleLocal(thread, key);
    return true;
  }
  if (!store.hostUp || !isTurnKey(key) || useConnectionStore.getState().status !== "connected") return false;
  const on = !onHost.includes(key);
  store.setHostLocal(thread, key, on);
  socket.send(encode({ t: "bookmark.set", thread, message: key, on }));
  return true;
}

/**
 * A screen showing `thread` opened: asks for its reactions now and after every reconnect until the
 * returned function is called (the screen closed).
 */
export function watchReactions(thread: string): () => void {
  reactionThreads.set(thread, (reactionThreads.get(thread) ?? 0) + 1);
  getReactions(thread);
  return () => {
    const count = (reactionThreads.get(thread) ?? 1) - 1;
    if (count > 0) reactionThreads.set(thread, count);
    else reactionThreads.delete(thread);
  };
}

/**
 * A screen showing `thread` opened: asks for its artifacts now and after every reconnect until the
 * returned function is called. The host pushes each later change on its own.
 */
export function watchArtifacts(thread: string): () => void {
  artifactThreads.set(thread, (artifactThreads.get(thread) ?? 0) + 1);
  if (useConnectionStore.getState().status === "connected")
    socket.send(encode({ t: "artifacts.get", thread }));
  return () => {
    const count = (artifactThreads.get(thread) ?? 1) - 1;
    if (count > 0) artifactThreads.set(thread, count);
    else artifactThreads.delete(thread);
  };
}

/**
 * Changes `thread`'s artifacts or tabs as Isaac. Pins, renames, hide/show and clearing a tab's
 * blue dot show at once; the host's next snapshot confirms them (or puts them right). Resolves with
 * the host's `artifacts.acted`; fails at once while not connected.
 */
export function actArtifacts(thread: string, action: ArtifactAction): Promise<ActResult> {
  if (useConnectionStore.getState().status !== "connected")
    return Promise.resolve({ ok: false, error: "Not connected to your Mac." });
  const store = useArtifactsStore.getState();
  if (action.op === "pin")
    store.pin(thread, action.id, action.pinned ? { by: "isaac", at: Date.now() } : undefined);
  if (action.op === "pin.remove") store.pin(thread, action.id, undefined);
  if (action.op === "tab.update") {
    const { title, hidden, fresh } = action;
    store.patchTab(thread, action.tab, {
      ...(title === undefined ? {} : { title }),
      ...(hidden === undefined ? {} : { hidden }),
      ...(fresh === undefined ? {} : { fresh }),
    });
  }
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const answer = pendingActs.add(rid);
  socket.send(encode({ t: "artifacts.act", thread, rid, by: "isaac", action }));
  return answer;
}

/** Ephemeral; the answer lands in `useStudioStore()`. Also sent on every welcome. */
export function requestStudio(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "studio.list" }));
}

/**
 * One Studio request (create, quote, cancel, delete, upload, frame, refresh). Resolves with the
 * host's `studio.res`; fails at once while not connected and after `STUDIO_TIMEOUT_MS` unanswered.
 */
export function studioRequest(op: StudioOp): Promise<StudioResult> {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  if (useConnectionStore.getState().status !== "connected")
    return Promise.resolve({ rid, ok: false, error: "Not connected to your Mac." });
  const answer = pendingStudio.add(rid);
  socket.send(encode({ t: "studio.req", rid, op }));
  return answer;
}

/** Ephemeral; the answer lands in `useRoomsStore()`. Also sent on every welcome. Nothing goes to a host without Rooms. */
export function requestRooms(): void {
  if (useConnectionStore.getState().status !== "connected" || useRoomsStore.getState().supported !== true) return;
  socket.send(encode({ t: "rooms.get", ...(useRoomsStore.getState().chats ? { chat: true } : {}) }));
}

/**
 * One Rooms command (create, post, raise, budget, answer, stop, pause, resume, image). The desktop's
 * answer resolves it; fails at once while not connected or when the host has no Rooms (an older host
 * would drop the socket on the frame) or, for pause / resume, no ROOMS_RESUME_FEATURE, and after
 * `ROOMS_TIMEOUT_MS` unanswered.
 */
export function roomsRequest(cmd: RoomsCmd): Promise<RoomsResult> {
  if (useConnectionStore.getState().status !== "connected")
    return Promise.resolve({ ok: false, code: "offline", message: "Not connected to your Mac." });
  const rooms = useRoomsStore.getState();
  if (rooms.supported !== true || ((cmd.op === "pause" || cmd.op === "resume") && !rooms.resumes))
    return Promise.resolve({ ok: false, code: "unsupported", message: "Update Relay Host on your Mac to use Rooms." });
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const answer = pendingRooms.add(rid);
  socket.send(encode({ t: "rooms.cmd", rid, cmd }));
  return answer;
}

function sendReviews(op: ReviewsOp): Promise<ReviewsResult> {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const answer = pendingReviews.add(rid, op);
  socket.send(encode({ t: "reviews.req", rid, op }));
  return answer;
}

/**
 * One Reviews request (queue, an item's detail, Done, a confirmed post, an Astra ask). What the
 * answer carries lands in `useReviewsStore()`; resolves with the host's `reviews.res`, fails at once
 * while not connected and after the op's timeout (`reviewsTimeout`) unanswered.
 */
export function reviewsRequest(op: ReviewsOp): Promise<ReviewsResult> {
  if (useConnectionStore.getState().status !== "connected")
    return Promise.resolve({ rid: "offline", ok: false, error: "Not connected to your Mac." });
  return sendReviews(op);
}

/**
 * One Meetings request (a record's detail, a recording's page, an Astra ask, accept, dismiss,
 * stop, discard). A page snapshot or an Astra answer lands in `useMeetingsStore()`; resolves with
 * the host's `meetings.res`, fails at once while not connected and after its timeout unanswered.
 */
export function meetingsRequest(op: MeetingsOp): Promise<MeetingsResult> {
  const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  if (useConnectionStore.getState().status !== "connected")
    return Promise.resolve({ rid, ok: false, error: "Not connected to your Mac." });
  const answer = pendingMeetings.add(rid, op);
  socket.send(encode({ t: "meetings.req", rid, op }));
  return answer;
}

/** Ephemeral; the answer lands in `useMeetingsStore()`. Also sent on every welcome. */
export function requestMeetings(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "meetings.list" }));
}

/**
 * Reacts `emoji` to bubble `key` (its `reactionKey`) of `thread`, or takes the reaction back for
 * null; `text` is the bubble's text, sent as the excerpt the agent's note quotes. Shown at once,
 * then the host's `reactions.snapshot` confirms it (or puts it right). False, and nothing changed,
 * while not connected: only the host keeps reactions.
 */
export function react(thread: string, key: string, emoji: string | null, text: string): boolean {
  if (useConnectionStore.getState().status !== "connected") return false;
  const excerpt = reactionExcerpt(text);
  useReactionsStore.getState().setLocal(thread, key, emoji, excerpt, Date.now());
  socket.send(
    encode(
      emoji === null
        ? { t: "reaction.clear", thread, message: key }
        : { t: "reaction.set", thread, message: key, emoji, excerpt },
    ),
  );
  return true;
}

/**
 * Asks the host for a way into the live view: the answer lands in `useVncStore().access` as a
 * bridge URL with a single-use ticket, or `off` when Screen Sharing is off on the Mac. Ephemeral;
 * no-op unless connected.
 */
export function requestVncAccess(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  useVncStore.getState().setAccess({ kind: "asking" });
  socket.send(encode({ t: "vnc.open" }));
}

/**
 * Asks for a way into the live canvas room on board `slug`: the answer lands in
 * `useCanvasStore().access[slug]` as the host web client's URL with a token, or `unavailable`
 * when the session there ended. A token still good for a while is reused, so stepping back into
 * the room never reloads it. Ephemeral; while not connected the request waits as `asking` and the
 * next welcome sends it.
 */
export function requestCanvasAccess(slug: string): void {
  beginCanvasAccess(useCanvasStore.getState(), slug, {
    now: Date.now(),
    connected: useConnectionStore.getState().status === "connected",
    send: (message) => {
      socket.send(encode(message));
    },
  });
}

/**
 * `http://<host>:<port>` of the live connection, the prefix for `Drop.file.path` blob fetches.
 * `null` when not connected: there is no host to fetch from and no drop list to fetch for.
 */
export function hostBaseUrl(): string | null {
  if (useConnectionStore.getState().status !== "connected" || hostAuthority === null) return null;
  return `http://${hostAuthority}`;
}

/** Ephemeral; the host keeps the token per device, so this is re-sent on every connection. */
export function registerPush(token: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "push.register", token }));
}

export function unregisterPush(): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "push.unregister" }));
}

/** The assistants this phone wants no pushes from; the host replaces its list for this device. Re-sent on every connection. */
export function sendPushPrefs(muted: readonly string[]): void {
  if (useConnectionStore.getState().status !== "connected") return;
  socket.send(encode({ t: "push.prefs", muted: [...muted] }));
}

/**
 * Tells the host media in an assistant's bubble failed to show here (`render.failed`), so it can
 * tell the agent to repost it. Fire and forget. False, and nothing sent, while not connected or to
 * a host without `render.report` (an older host drops the socket on frames it doesn't know).
 */
export function reportRenderFailure(failure: RenderReport): boolean {
  if (useConnectionStore.getState().status !== "connected" || !hostTakesRenders) return false;
  socket.send(encode(renderFailedFrame(failure)));
  return true;
}

/**
 * Reconnects now. A notification action can wake the app in the background, where it closed its
 * socket on backgrounding and no `appActive` will come; without this the answer would have no host
 * to go to. A no-op while connected or already connecting.
 */
export function wakeConnection(): void {
  const status = useConnectionStore.getState().status;
  if (
    status === "connected" ||
    status === "connecting" ||
    status === "authenticating" ||
    status === "pairing"
  )
    return;
  void dispatch({ type: "appActive" });
}

/**
 * Ephemeral; the answer lands in `useAgentsStore().images[sessionId][id]`. Asked at most once per
 * ref: a store entry (even `null`, "host has none") or an in-flight request means no new frame.
 */
export function requestAgentImage(sessionId: string, id: string): void {
  if (useConnectionStore.getState().status !== "connected") return;
  if (useAgentsStore.getState().images[sessionId]?.[id] !== undefined) return;
  const key = imageKey(sessionId, id);
  if (imagesInFlight.has(key)) return;
  imagesInFlight.add(key);
  socket.send(encode({ t: "agent.image", sessionId, id }));
}

/**
 * Reliable; resolves on ack, rejects with an `AckError`-shaped `Error` on nack, with code
 * `"timeout"` once the ack is overdue (the command lives on as unconfirmed: a late ack or nack
 * reaches `onCommandReport`) and `"unsent"` when it never got out. Sending a turn again with the
 * same `clientId` reuses its command id. A reply shows from
 * this moment (`useAgentsStore()`), every path that sends one alike (typed, dictated, the skill
 * wheel, a widget button): a slash command as running (`sent`), other words as the user's bubble
 * (`echoes`). A refused command stops showing; refused words keep their bubble, marked.
 */
export function sendCommand(cmd: Command): Promise<void> {
  const promise = commandQueue.enqueue(cmd, (message) => socket.send(encode(message)));
  if (cmd.kind === "agent.reply") {
    const at = Date.now();
    useAgentsStore.getState().noteSent(cmd.sessionId, cmd.text, at);
    promise.catch((error: unknown) => {
      const agents = useAgentsStore.getState();
      agents.dropSent(cmd.sessionId, at);
      agents.failEcho(
        cmd.sessionId,
        error instanceof Error && error.message !== "" ? error.message : "Not sent.",
        at,
      );
    });
  }
  return promise;
}

/** Commands sent or queued whose outcome is not settled: pending (queued or on the wire) plus unconfirmed. */
export function commandsOutstanding(): number {
  return commandQueue.outstanding;
}

/** Hears every command that turns unconfirmed and every late ack or nack of one. Returns the unsubscribe. */
export function onCommandReport(listener: (report: CommandReport) => void): () => void {
  return commandQueue.onReport(listener);
}

/** Monotonic ms, matching `InputEvent.t`'s unit. */
export function getClientTime(): number {
  return performance.now();
}

export const connection = {
  start(): void {
    if (started) return;
    started = true;
    setActions({
      insertText: (text) => sendCommand({ kind: "text.insert", text }),
      startPairing: () => {
        void dispatch({ type: "startPairing" });
      },
      submitPin: (pin) => {
        void dispatch({ type: "pinEntered", pin });
      },
      switchHost: (id) => {
        void switchHost(id);
      },
      forgetHost: (id) => {
        void forgetHost(id);
      },
    });
    boot().catch((error: unknown) => {
      warn("boot", "failed", error);
    });
  },
  stop(): void {
    if (!started) return;
    started = false;
    appStateSubscription?.remove();
    appStateSubscription = null;
    discovery.stop();
    socket.close();
    clearTimeout(retryTimer);
    retryTimer = undefined;
    machine = null;
  },
};

/** Keeps Bonjour browsing (and `useConnectionStore().discovered` fresh) while a host picker is open. */
export function browseHosts(on: boolean): void {
  if (mayDiscover(ONLY_HOST)) discovery.browse(on);
}

/** Mounts the connection lifecycle to the app's root component tree. */
export function useConnectionLifecycle(): void {
  useEffect(() => {
    connection.start();
    return () => {
      connection.stop();
    };
  }, []);
}
