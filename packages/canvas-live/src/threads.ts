// Comment pins and their threads (Figma-style): a pin on a node (it follows the node when moved)
// or on a board point, holding a thread of messages from the humans and the agents who answer
// there, open or resolved. Pure helpers over the room's Y.Doc, shared by the host (agent, board
// file) and the web client; the board file keeps them under `threads` (board.ts).
//
// Y.Doc: threads: Y.Map<threadId, Y.Map { node?: string, x: number, y: number, resolved: boolean,
//                                        messages: Y.Array<ThreadMsg> }>

import * as Y from "yjs";
import { DOC_KEYS } from "./shared";

/**
 * Where a pin sits. With `node`, `x`/`y` are its offset from that node's top-left, so the pin
 * moves with the node; without, they are a point on the board.
 */
export interface ThreadAnchor {
  node?: string;
  x: number;
  y: number;
}

export interface ThreadMsg {
  id: string;
  kind: "human" | "agent";
  name: string;
  color: string;
  /** Host-relative avatar URL (`/canvas/avatar/<key>`, `/canvas/portrait/<seed>`), agents that have one. */
  avatar?: string;
  text: string;
  /** Epoch ms. */
  ts: number;
}

export interface ThreadSnap {
  id: string;
  anchor: ThreadAnchor;
  resolved: boolean;
  /** The agent the thread is for (a registry assistant's id, else a joined agent's lowercased name): replies go to it until someone else is mentioned. Absent: the room's canvas self. */
  assignee?: string;
  messages: ThreadMsg[];
}

export type ThreadMap = Y.Map<unknown>;

/** Longest message a thread keeps. */
export const MAX_THREAD_TEXT = 4000;
/** A thread id: what a board file, the DSL (`@reply <id>`) and the client all accept. */
export const THREAD_ID = /^[A-Za-z0-9][\w.-]{0,59}$/;

export const threadsOf = (doc: Y.Doc): Y.Map<ThreadMap> => doc.getMap<ThreadMap>(DOC_KEYS.threads);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function messagesOf(t: ThreadMap | undefined): Y.Array<ThreadMsg> | null {
  const m = t?.get("messages");
  return m instanceof Y.Array ? (m as Y.Array<ThreadMsg>) : null;
}

/** A message as stored: text trimmed and capped, no empty optional fields. */
export function cleanMessage(msg: ThreadMsg): ThreadMsg {
  const out: ThreadMsg = { id: msg.id, kind: msg.kind, name: msg.name, color: msg.color, text: msg.text.trim().slice(0, MAX_THREAD_TEXT), ts: msg.ts };
  if (msg.avatar !== undefined && msg.avatar !== "") out.avatar = msg.avatar;
  return out;
}

/** A new thread's map (not yet in a doc). */
export function threadMap(anchor: ThreadAnchor, resolved: boolean, messages: readonly ThreadMsg[], assignee?: string): ThreadMap {
  const m = new Y.Map<unknown>();
  if (anchor.node !== undefined) m.set("node", anchor.node);
  m.set("x", anchor.x);
  m.set("y", anchor.y);
  m.set("resolved", resolved);
  if (assignee !== undefined && assignee !== "") m.set("assignee", assignee);
  const list = new Y.Array<ThreadMsg>();
  list.push(messages.map(cleanMessage));
  m.set("messages", list);
  return m;
}

/** Opens thread `id` at `anchor` with its first message. False when the id is taken or the text is empty. */
export function openThread(threads: Y.Map<ThreadMap>, id: string, anchor: ThreadAnchor, first: ThreadMsg, assignee?: string): boolean {
  if (threads.has(id) || !THREAD_ID.test(id) || first.text.trim() === "") return false;
  threads.set(id, threadMap(anchor, false, [first], assignee));
  return true;
}

/** Adds `msg` to thread `id`; a human writing in a resolved thread reopens it. False when there is no such thread. */
export function postInThread(threads: Y.Map<ThreadMap>, id: string, msg: ThreadMsg): boolean {
  const t = threads.get(id);
  const list = messagesOf(t);
  if (t === undefined || list === null || msg.text.trim() === "") return false;
  const apply = (): void => {
    list.push([cleanMessage(msg)]);
    if (msg.kind === "human" && t.get("resolved") === true) t.set("resolved", false);
  };
  if (threads.doc) threads.doc.transact(apply);
  else apply();
  return true;
}

/** Moves thread `id`'s pin to `anchor` (onto a card, or a board point), in one transaction. False when there is no such thread. */
export function moveThread(threads: Y.Map<ThreadMap>, id: string, anchor: ThreadAnchor): boolean {
  const t = threads.get(id);
  if (t === undefined) return false;
  const apply = (): void => {
    if (anchor.node === undefined) {
      if (t.has("node")) t.delete("node");
    } else if (t.get("node") !== anchor.node) t.set("node", anchor.node);
    if (t.get("x") !== anchor.x) t.set("x", anchor.x);
    if (t.get("y") !== anchor.y) t.set("y", anchor.y);
  };
  if (threads.doc) threads.doc.transact(apply);
  else apply();
  return true;
}

/** Hands thread `id` to `assignee` (null: back to the canvas self). False when there is no such thread. */
export function setAssignee(threads: Y.Map<ThreadMap>, id: string, assignee: string | null): boolean {
  const t = threads.get(id);
  if (t === undefined) return false;
  if (assignee === null || assignee === "") {
    if (t.has("assignee")) t.delete("assignee");
  } else if (t.get("assignee") !== assignee) t.set("assignee", assignee);
  return true;
}

/** Resolves or reopens thread `id`. False when there is no such thread. */
export function setResolved(threads: Y.Map<ThreadMap>, id: string, resolved: boolean): boolean {
  const t = threads.get(id);
  if (t === undefined) return false;
  if (t.get("resolved") !== resolved) t.set("resolved", resolved);
  return true;
}

/** Thread `id` as plain data; null when its map is malformed. */
export function snapThread(id: string, m: ThreadMap): ThreadSnap | null {
  const x = m.get("x");
  const y = m.get("y");
  const list = messagesOf(m);
  if (!isNum(x) || !isNum(y) || list === null) return null;
  const node = m.get("node");
  return {
    id,
    anchor: typeof node === "string" && node !== "" ? { node, x, y } : { x, y },
    resolved: m.get("resolved") === true,
    ...(typeof m.get("assignee") === "string" && m.get("assignee") !== "" ? { assignee: m.get("assignee") as string } : {}),
    messages: list.toArray(),
  };
}

export function snapThreads(threads: Y.Map<ThreadMap>): ThreadSnap[] {
  const out: ThreadSnap[] = [];
  for (const [id, m] of threads) {
    const s = snapThread(id, m);
    if (s !== null) out.push(s);
  }
  return out;
}

/** When the thread last changed hands: its newest message. */
export function lastActivity(t: ThreadSnap): number {
  return t.messages.reduce((at, m) => Math.max(at, m.ts), 0);
}

/** Open threads, then resolved ones, each newest activity first. */
export function orderThreads(list: readonly ThreadSnap[]): { open: ThreadSnap[]; resolved: ThreadSnap[] } {
  const byActivity = (a: ThreadSnap, b: ThreadSnap): number => lastActivity(b) - lastActivity(a);
  return { open: list.filter((t) => !t.resolved).sort(byActivity), resolved: list.filter((t) => t.resolved).sort(byActivity) };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the pin's tip is on the board: inside its node (the offset kept within the node as it
 * resizes), at its point, or null when its node is gone.
 */
export function pinAt(anchor: ThreadAnchor, nodeBox: Box | null): { x: number; y: number } | null {
  if (anchor.node === undefined) return { x: anchor.x, y: anchor.y };
  if (nodeBox === null) return null;
  return { x: nodeBox.x + Math.max(0, Math.min(anchor.x, nodeBox.w)), y: nodeBox.y + Math.max(0, Math.min(anchor.y, nodeBox.h)) };
}

/** A node's corner pin: near its top-right, inside the card. */
export const CORNER = { right: 28, top: 18 } as const;

/**
 * The anchor for a comment made at board point `at`: on `node` at that spot when it falls inside
 * the node, else at the node's top-right corner; with no node, the point itself (the board's
 * origin when there is no point either).
 */
export function anchorFor(at: { x: number; y: number } | null, node: { id: string; box: Box } | null): ThreadAnchor {
  if (node === null) return { x: Math.round(at?.x ?? 0), y: Math.round(at?.y ?? 0) };
  const { box } = node;
  const inside = at !== null && at.x >= box.x && at.x <= box.x + box.w && at.y >= box.y && at.y <= box.y + box.h;
  if (inside) return { node: node.id, x: Math.round(at.x - box.x), y: Math.round(at.y - box.y) };
  return { node: node.id, x: Math.max(0, Math.round(box.w - CORNER.right)), y: CORNER.top };
}

/** One line of `text`, at most `max` characters. */
export function excerpt(text: string, max = 90): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

/** A fresh thread id. */
export function newThreadId(now = Date.now()): string {
  return `t-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
