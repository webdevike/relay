// Live canvas room: shared between the Relay host (room, agent participant) and the web client.
//
// Y.Doc layout (one doc per board slug, seeded from and exported to the EvaOS board JSON):
//   nodes:    Y.Map<id, Y.Map>  { type, x?, y?, w?, h?, parent?, title: Y.Text, body: Y.Text,
//                                 key?, status?, pr?, src?, caption?, url?, tone?, colors?, font?, sample?,
//                                 system?, viewport?,
//                                 fields: string[] (data keys the file had, so export round-trips) }
//   edges:    Y.Map<id, Y.Map>  { source, target, sourceHandle?, targetHandle?, label?, tone? }
//   meta:     Y.Map             { title, layout?, viewport?, session: SessionInfo }
//   chat:     Y.Array<ChatMsg>  room chat log (agents' room lines, session events)
//   threads:  Y.Map<id, Y.Map>  comment pins and their threads (threads.ts) { node?, x, y, resolved, messages: Y.Array<ThreadMsg> }
//   settings: Y.Map             { model: ModelKey, tidy?: boolean (false: cards may overlap and links draw as curves through them) }
//   metrics:  Y.Map             "s:<msgId>" → ServerMetrics, "c:<msgId>" → ClientMetrics
//   pages:    page-1 is the maps above; every other page has nodes:<pageId>, edges:<pageId>, threads:<pageId>
//             and meta "viewport:<pageId>"; meta.pages holds the order and titles (pages.ts)

/**
 * `ui`: a live OpenUI widget; `title` is its card title and `body` its OpenUI Lang source (Query data, buttons and inputs run in every client).
 * `proto`: an interactive prototype; `title` is its card title, `body` its JSX (the ```mantine-widget contract), `system` the design
 * system it draws in (`relay`, `ecard`, `mantine`; @relay/widget-runtime/systems) and `viewport` `mobile` for a phone-width screen.
 */
export const NODE_KINDS = ["topic", "note", "ticket", "image", "link", "frame", "suggestion", "palette", "typography", "ui", "proto"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Data keys stored as plain values on a node's Y.Map (title and body are Y.Text). */
export const PLAIN_DATA_KEYS = ["key", "status", "pr", "src", "caption", "url", "tone", "colors", "font", "sample", "system", "viewport"] as const;
export type PlainDataKey = (typeof PLAIN_DATA_KEYS)[number];

export type TextField = "title" | "body";
export type ModelKey = "opus" | "sonnet" | "haiku";

export const MODELS: Record<ModelKey, { id: string; label: string }> = {
	opus: { id: "anthropic/claude-opus-5-5", label: "Opus 5.5" },
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
	/** The page this participant is on (pages.ts); absent: page-1. Cursor, selection and caret are on this page. */
	page?: string;
	/** Pointer in flow coordinates, so it lines up at any zoom. Touch clients send their last tap. */
	cursor?: { x: number; y: number } | null;
	selected?: string[];
	/** Cursor chat being typed right now (live, like Figma). */
	draft?: string | null;
	/** Chat bubble shown at the cursor; with `thread`, a reply being written in that comment thread (shown there, not at the cursor). */
	bubble?: { text: string; replyTo?: string; streaming?: boolean; thread?: string } | null;
	status?: AgentStatus;
	/** Message id the agent is working on. */
	replyTo?: string | null;
	/** Agent caret inside a node's text. */
	typing?: { nodeId: string; field: TextField; index: number; selectAll?: boolean } | null;
	/** Agent is dragging an edge out of this node. */
	connecting?: { source: string } | null;
	/** Agents: work handed to them that runs off the board (files, screenshots, research), while it runs. */
	task?: string | null;
	/** Agents: what it is doing right now off the board, as a short status line ("building the mockup…"). */
	doing?: string | null;
	/** This client tidies (pushes overlapping cards apart); the lowest such human id tidies changes no client owns. */
	tidy?: boolean;
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
	/** A note posted in a comment thread (threads.ts): the agent answers there. Never stored in `chat`. */
	thread?: string;
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

export const DOC_KEYS = { nodes: "nodes", edges: "edges", meta: "meta", chat: "chat", threads: "threads", settings: "settings", metrics: "metrics" } as const;
