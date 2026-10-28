// Live canvas room: shared between the Relay host (room, agent participant) and the web client.
//
// Y.Doc layout (one doc per board slug, seeded from and exported to the EvaOS board JSON):
//   nodes:    Y.Map<id, Y.Map>  { type, x?, y?, w?, h?, parent?, title: Y.Text, body: Y.Text,
//                                 key?, status?, pr?, src?, caption?, url?, tone?, colors?, font?, sample?,
//                                 fields: string[] (data keys the file had, so export round-trips) }
//   edges:    Y.Map<id, Y.Map>  { source, target, sourceHandle?, targetHandle?, label?, tone? }
//   meta:     Y.Map             { title, layout?, viewport?, session: SessionInfo }
//   chat:     Y.Array<ChatMsg>  cursor-chat log (humans' notes, agent replies, session events)
//   settings: Y.Map             { model: ModelKey }
//   metrics:  Y.Map             "s:<msgId>" → ServerMetrics, "c:<msgId>" → ClientMetrics

export const NODE_KINDS = ["topic", "note", "ticket", "image", "link", "frame", "suggestion", "palette", "typography"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Data keys stored as plain values on a node's Y.Map (title and body are Y.Text). */
export const PLAIN_DATA_KEYS = ["key", "status", "pr", "src", "caption", "url", "tone", "colors", "font", "sample"] as const;
export type PlainDataKey = (typeof PLAIN_DATA_KEYS)[number];

export type TextField = "title" | "body";
export type ModelKey = "sonnet" | "haiku";

export const MODELS: Record<ModelKey, { id: string; label: string }> = {
	sonnet: { id: "anthropic/claude-sonnet-5-5", label: "Sonnet 5.5" },
	haiku: { id: "anthropic/claude-haiku-5-5", label: "Haiku 5.5" },
};

export interface User {
	name: string;
	color: string;
	kind: "human" | "agent";
	/** Avatar URL relative to the host origin (`/canvas/avatar/<key>`), agents only. */
	avatar?: string;
}

export type AgentStatus = "idle" | "thinking" | "moving" | "typing" | "drawing";

export interface Presence {
	user: User;
	/** Pointer in flow coordinates, so it lines up at any zoom. Touch clients send their last tap. */
	cursor?: { x: number; y: number } | null;
	selected?: string[];
	/** Cursor chat being typed right now (live, like Figma). */
	draft?: string | null;
	/** Chat bubble shown at the cursor. */
	bubble?: { text: string; replyTo?: string; streaming?: boolean } | null;
	status?: AgentStatus;
	/** Message id the agent is working on. */
	replyTo?: string | null;
	/** Agent caret inside a node's text. */
	typing?: { nodeId: string; field: TextField; index: number; selectAll?: boolean } | null;
	/** Agent is dragging an edge out of this node. */
	connecting?: { source: string } | null;
}

export interface ChatMsg {
	id: string;
	/** "event" = session notices (joined, wrapped up). */
	kind: "human" | "agent" | "event";
	name: string;
	color: string;
	text: string;
	nodeIds: string[];
	at: { x: number; y: number } | null;
	ts: number;
	replyTo?: string;
	model?: ModelKey;
}

/** Server-measured, ms after the server received the message. */
export interface ServerMetrics {
	model: ModelKey;
	cursor: number;
	firstToken: number;
	firstEdit: number | null;
	/** Model stream finished (edits may still be animating). */
	modelDone: number;
	done: number;
	output: string;
}

/** Client-measured, ms after the human pressed Enter (includes network both ways). */
export interface ClientMetrics {
	cursor: number | null;
	firstToken: number | null;
	done: number | null;
}

/** Canvas session state, kept in the doc's `meta` map under "session". */
export interface SessionInfo {
	roomId: string;
	/** The agent in the room (one for now). */
	agent: User;
	/** Title of the chat the session came from ("Fix login", "Nova"). */
	chatTitle: string;
	open: boolean;
	startedAt: number;
	endedAt: number | null;
	summary: string | null;
}

/** Messages an embedded client posts to its parent (iframe parent or React Native WebView). */
export type EmbedEvent = { type: "canvas.ready"; slug: string } | { type: "canvas.ended"; slug: string; summary: string | null };

export const DOC_KEYS = { nodes: "nodes", edges: "edges", meta: "meta", chat: "chat", settings: "settings", metrics: "metrics" } as const;
