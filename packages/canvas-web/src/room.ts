// The live room: one Y.Doc synced with the host over y-websocket, awareness for presence, and
// this tab's identity (from the host's `/me`, so nobody is asked for a name).
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { type ChatMsg, DOC_KEYS, type Presence, type User } from "../../canvas-live/src/shared";
import { parseEnv, roomUrl, wsParams, wsServer } from "./env";
import { HUMAN_COLORS, freeColor, uniqueName } from "./model";

export const env = parseEnv(location.href);
export const doc = new Y.Doc();
export const provider = new WebsocketProvider(wsServer(env), "ws", doc, { params: wsParams(env) });
export const awareness = provider.awareness;
// Nobody sees this tab until it knows who it is.
awareness.setLocalState(null);

export const yNodes = doc.getMap<Y.Map<unknown>>(DOC_KEYS.nodes);
export const yEdges = doc.getMap<Y.Map<unknown>>(DOC_KEYS.edges);
export const yMeta = doc.getMap<unknown>(DOC_KEYS.meta);
export const yChat = doc.getArray<ChatMsg>(DOC_KEYS.chat);
export const ySettings = doc.getMap<unknown>(DOC_KEYS.settings);
export const yMetrics = doc.getMap<unknown>(DOC_KEYS.metrics);

// Handle for scripted QA (reconnect and concurrent-edit checks).
Object.assign(window, { __canvas: { doc, provider, awareness } });

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
	self.color = me?.me.color || HUMAN_COLORS[Math.floor(Math.random() * HUMAN_COLORS.length)] || "#0ea5e9";
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
		awareness.setLocalState({ user: { ...self }, cursor: null, selected: [], tidy: true } satisfies Presence);
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
