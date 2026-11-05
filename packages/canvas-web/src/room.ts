// The live room: one Y.Doc synced with the host over y-websocket, awareness for presence, this
// tab's identity (from the host's `/me`, so nobody is asked for a name) and the board page it is on.
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { FIRST_PAGE, type PageInfo, type PageMaps, pageMaps, pagesOf } from "../../canvas-live/src/pages";
import { type ChatMsg, DOC_KEYS, type Presence, type User } from "../../canvas-live/src/shared";
import { fallbackPage } from "./boardpages";
import { parseEnv, roomUrl, wsParams, wsServer } from "./env";
import { HUMAN_COLORS, createUndo, freeColor, uniqueName } from "./model";

export const env = parseEnv(location.href);
export const doc = new Y.Doc();
export const provider = new WebsocketProvider(wsServer(env), "ws", doc, { params: wsParams(env) });
export const awareness = provider.awareness;
// Nobody sees this tab until it knows who it is.
awareness.setLocalState(null);

export const yMeta = doc.getMap<unknown>(DOC_KEYS.meta);
export const yChat = doc.getArray<ChatMsg>(DOC_KEYS.chat);
export const ySettings = doc.getMap<unknown>(DOC_KEYS.settings);
export const yMetrics = doc.getMap<unknown>(DOC_KEYS.metrics);

/** A page's nodes, edges and threads, and this viewer's undo stack on it (only their own moves, deletes and groups, see `createUndo`). */
export interface PageView extends PageMaps {
  id: string;
  undo: Y.UndoManager;
}

const views = new Map<string, PageView>();

/** Page `id`'s view, made once per page and kept, so its undo stack survives switching away and back. */
export function pageView(id: string): PageView {
  let view = views.get(id);
  if (view === undefined) {
    const maps = pageMaps(doc, id);
    view = { id, ...maps, undo: createUndo(maps.nodes, maps.edges) };
    views.set(id, view);
  }
  return view;
}

// ---------- the page this viewer is on ----------
// The board remounts per page (App.tsx), so everything it shows and edits reads `page()`.

let current = FIRST_PAGE;
/** Pages as last seen, to find the nearest one when the current page is deleted. */
let known: PageInfo[] = pagesOf(doc);
/** The viewer (or Follow) picked a page: the first sync no longer moves them to the first one. */
let chosen = false;
const pageListeners = new Set<() => void>();

/** The id of the page this viewer is on. */
export function currentPage(): string {
  return current;
}

/** The page this viewer is on: its maps and undo stack. */
export function page(): PageView {
  return pageView(current);
}

function go(id: string): void {
  if (id === current) return;
  current = id;
  // Cursor, selection and cursor chat belong to the page left behind.
  const s = awareness.getLocalState() as Presence | null;
  if (s) awareness.setLocalState({ ...s, page: id, cursor: null, selected: [], draft: null } satisfies Presence);
  for (const l of pageListeners) l();
}

/** Switches this viewer to page `id`. */
export function setPage(id: string): void {
  chosen = true;
  go(id);
}

export function subscribePage(cb: () => void): () => void {
  pageListeners.add(cb);
  return () => pageListeners.delete(cb);
}

yMeta.observe((e) => {
  if (!e.keysChanged.has("pages")) return;
  const next = pagesOf(doc);
  const to = fallbackPage(known, next, current);
  known = next;
  go(to);
});
// A board opens on its first page.
provider.once("sync", () => {
  if (!chosen) go(pagesOf(doc)[0]?.id ?? FIRST_PAGE);
});

// Handle for scripted QA (reconnect, concurrent-edit and zoom checks); the board adds `rf`.
export const qa: {
  doc: Y.Doc;
  provider: WebsocketProvider;
  awareness: typeof awareness;
  rf?: unknown;
} = { doc, provider, awareness };
Object.assign(window, { __canvas: qa });

/** `GET /canvas/<slug>/me`. */
export interface RoomMe {
  me: { name: string; color: string };
  roomId: string;
  board: string;
  agent: { name: string; color: string; avatar?: string };
  live: boolean;
}

export const self: User = { name: "", color: "", kind: "human" };
export let roomMe: RoomMe | null = null;

function isRoomMe(v: unknown): v is RoomMe {
  if (!v || typeof v !== "object" || !("me" in v) || !("agent" in v)) return false;
  const me = v.me as { name?: unknown } | null;
  return !!me && typeof me.name === "string";
}

/**
 * Who this tab is. A token the host refuses means the link expired ("expired"); a host without
 * `/me` (the spike) gets a default identity, `?name=` or "Guest".
 */
export async function loadIdentity(): Promise<"ok" | "expired"> {
  let me: RoomMe | null = null;
  try {
    const res = await fetch(roomUrl(env, "me"), { cache: "no-store" });
    if (res.status === 401 || res.status === 403) return "expired";
    if (res.ok) {
      const body: unknown = await res.json();
      if (isRoomMe(body)) me = body;
    }
  } catch {
    // Offline or no host route: default identity below; the websocket reports the rest.
  }
  roomMe = me;
  self.name = me?.me.name || new URLSearchParams(location.search).get("name") || "Guest";
  self.color =
    me?.me.color || HUMAN_COLORS[Math.floor(Math.random() * HUMAN_COLORS.length)] || "#0ea5e9";
  const join = () => {
    // Each tab is its own participant: a second tab becomes "Isaac 2" in a free color.
    const names = new Set<string>();
    const colors = new Set<string>();
    for (const [cid, s] of presenceStates()) {
      if (cid === awareness.clientID || !s.user) continue;
      names.add(s.user.name);
      colors.add(s.user.color);
    }
    self.name = uniqueName(self.name, names);
    self.color = freeColor(self.color, colors);
    awareness.setLocalState({
      user: { ...self },
      page: current,
      cursor: null,
      selected: [],
      tidy: true,
    } satisfies Presence);
  };
  if (provider.synced) join();
  else provider.once("sync", join);
  return "ok";
}

export function presenceStates(): Map<number, Presence> {
  return awareness.getStates() as Map<number, Presence>;
}

export function subscribePresence(cb: () => void): () => void {
  awareness.on("change", cb);
  return () => awareness.off("change", cb);
}

export function subscribeDoc(cb: () => void): () => void {
  doc.on("update", cb);
  return () => doc.off("update", cb);
}

/** Sets one field of this tab's presence (no-op before it joined). */
export function setPresence<K extends keyof Presence>(key: K, value: Presence[K]): void {
  if (awareness.getLocalState()) awareness.setLocalStateField(key, value);
}
