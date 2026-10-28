// The agent in a canvas room: the same session that started the canvas (its name, color, avatar
// and its chat as context), as a participant in the room's Y.Doc. Board edits are plain CRDT ops
// in the host's copy of the doc (origin "agent"); its cursor, selection, caret and chat bubble are
// its awareness state, tweened here at ~30 fps.
//
// The opener is generated when the room starts and played when the first human joins, so it lands
// at once. Every human cursor-chat note is a turn: the cursor moves to what the note points at
// before the model is asked, the reply streams into the bubble and its actions run as their lines
// complete. Wrap up (the button, the CLI, or the room empty for a while) writes the summary.

import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { placeUnplaced, type LayoutNode } from "@relay/canvas-live/layout";
import { DOC_KEYS, type ChatMsg, type ModelKey, type NodeKind, type Presence, type ServerMetrics, type TextField, type User } from "@relay/canvas-live/shared";
import type { CanvasBrain } from "./brain";
import { type Action, ActionParser, TextStream } from "./dsl";

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function sleep(ms: number): Promise<undefined> {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  setTimeout(resolve, ms, undefined);
  return promise;
}

/** Doc updates the agent makes carry this origin. */
export const AGENT_ORIGIN = "agent";

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Who and what the agent is in this room. */
export interface AgentIdentity {
  readonly user: User;
  /** The human the room is for (the name on the access tokens). */
  readonly human: string;
  /** The chat the canvas came from, as Relay titles it ("Fix login", "Nova"). */
  readonly chatTitle: string;
  /** What the session is for, from `canvas start --prompt`; empty when not given. */
  readonly purpose: string;
  /** The chat's turns (context.ts), empty when the file had none. */
  readonly chat: string;
  readonly chatTurns: number;
}

export interface AgentHooks {
  /** A finished exchange at the canvas: the note and the agent's reply. */
  turn(human: { name: string; text: string }, reply: string): void;
  /** The session wrapped up with `summary` (posted to the chat by the room). Called once. */
  ended(summary: string): void;
  log(line: string): void;
}

export interface AgentOptions {
  /** Wrap up this long after the last human left. */
  readonly endAfterMs: number;
  /** Cursor tween frame; tests shorten the animation. */
  readonly frameMs?: number;
  /** Delay per typed chunk. */
  readonly typeMs?: number;
}

type Turn = { kind: "message"; msg: ChatMsg } | { kind: "open" } | { kind: "close"; done: (summary: string) => void };

export function systemPrompt(identity: AgentIdentity): string {
  const { user, human, chatTitle, purpose, chat, chatTurns } = identity;
  const name = user.name;
  const base = `You are ${name}, ${human}'s assistant. This is the same ${name} as in the Relay chat below ("${chatTitle}"): the conversation has moved into a shared canvas board, like a design review over Zoom with a real purpose. You are in the room with a named cursor; ${human} (and sometimes other people) click nodes and leave quick cursor-chat notes; you answer in a bubble at your cursor and edit the board live while they watch.

Every turn you get: the board's purpose, the full current board (every node's id, type, position, size and full text, all edges), who is here and which nodes each person has selected, the recent cursor chat, and the nodes attached to the note. Below is the chat that opened this board. Use all of it; never assume anything that is not there.

Voice: like talking, quick back and forth. Short plain sentences, lead with the point, at most one question per turn, never walls of text. No markdown. Never use em dashes; use commas, periods or parentheses.

Reply ONLY with action lines in this exact format (no code fences, no other prose):
@say <one short spoken line, max 25 words>
@point <nodeId>                   (glide your cursor to a node while you talk about it)
@select <nodeId>
@set_text <nodeId> <title|body>
<the full new text for that field, as many lines as needed>
@end
@append_text <nodeId> <title|body>
<lines to add at the end of that field>
@end
@add_node <newId> <note|topic|suggestion> <x> <y> <width>
<title on the first line>
<body lines>
@end
@move_node <nodeId> <x> <y>
@add_edge <sourceId> <targetId> <optional short label>
@delete <nodeId>

How to run the session:
- First line is @say, or @point then @say when you are talking about a node. When you change a node, the @say names it by its title.
- Drive toward the goal from the chat: after each exchange, propose the next step or ask for the one decision you need, pointing at the node it concerns.
- Two working notes are yours to keep current: "agenda" (title "Agenda", open questions, one per line numbered "1 · ") and "decisions" (title "Decisions", one line per decision, "· <decision>"). When ${human} makes a call (agrees, picks an option, says "let's do X"), add it to decisions with @append_text (use @set_text instead if the body still says "Nothing decided yet."), and remove that question from agenda with @set_text. Then point at the next open question.
- If a note is ambiguous (you cannot tell which node or what change they want, and the attached nodes, chat and board do not settle it), do NOT edit: reply with one @say asking one short, specific question, and nothing else.
- When a note critiques a node's wording, rewrite it with @set_text (whole field). Keep the board's voice: plain, concrete, short lines; keep numbering like "1 · ".
- Add a node only when it helps. Put new nodes in empty space beside the related node (right: x = node.x + node.w + 60, or below), never overlapping, width 360-460. Connect related nodes with @add_edge.
- New ids: short lowercase kebab-case. Use only ids that exist (or that you just added). Keep it fast: a few actions, and never touch nodes nobody asked about.`;
  const parts = [base];
  if (purpose !== "") parts.push(`What this canvas session is for (from when you started it): ${purpose}`);
  parts.push(chat === "" ? "(The chat that opened this board has no text turns yet.)" : `The chat that opened this board (${String(chatTurns)} turns, oldest first):\n<chat>\n${chat}\n</chat>`);
  return parts.join("\n\n");
}

const str = (m: Y.Map<unknown>, k: string): string => {
  const v = m.get(k);
  return v instanceof Y.Text ? v.toJSON() : typeof v === "string" ? v : "";
};
const num = (m: Y.Map<unknown>, k: string): number | undefined => {
  const v = m.get(k);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

export class CanvasAgent {
  private presence: Presence;
  private cursor = { x: -300, y: 240 };
  private readonly queue: Turn[] = [];
  private busy = false;
  private clearBubbleTimer: ReturnType<typeof setTimeout> | undefined;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly nodes: Y.Map<Y.Map<unknown>>;
  private readonly edges: Y.Map<Y.Map<unknown>>;
  private readonly chat: Y.Array<ChatMsg>;
  /** The opener, generated at start and played when the first human joins. */
  private opener: TextStream | null = null;
  private opened = false;
  private closed = false;
  private hadHumans = false;
  /** Set once the session wrapped up. */
  private summary: string | null = null;
  /** Absolute positions of nodes the file gives none, recomputed when the board changes. */
  private placed: Map<string, { x: number; y: number }> | null = null;
  private readonly onDocUpdate = (): void => {
    this.placed = null;
  };
  private readonly onChat = (event: Y.YArrayEvent<ChatMsg>, tr: Y.Transaction): void => {
    if (tr.local || this.closed) return;
    for (const d of event.changes.delta) {
      if (!Array.isArray(d.insert)) continue;
      for (const m of d.insert as ChatMsg[]) if (m.kind === "human") this.enqueue({ kind: "message", msg: m });
    }
  };
  private readonly onPresence = (): void => {
    this.watchPresence();
  };

  constructor(
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    private readonly identity: AgentIdentity,
    private readonly brain: (model: ModelKey) => CanvasBrain,
    private readonly hooks: AgentHooks,
    private readonly options: AgentOptions,
  ) {
    this.nodes = doc.getMap(DOC_KEYS.nodes);
    this.edges = doc.getMap(DOC_KEYS.edges);
    this.chat = doc.getArray(DOC_KEYS.chat);
    this.presence = { user: identity.user, cursor: this.cursor, status: "idle", selected: [] };
    awareness.setLocalState(this.presence);
    this.chat.observe(this.onChat);
    doc.on("update", this.onDocUpdate);
    awareness.on("change", this.onPresence);
  }

  get user(): User {
    return this.identity.user;
  }

  /** Generates the opener now, so it plays at once when the first human joins. */
  prepare(): void {
    const stream = new TextStream();
    this.opener = stream;
    const t0 = performance.now();
    this.brain(this.modelKey())
      .run(this.openerPrompt(), (delta) => {
        stream.push(delta);
      })
      .then(
        () => {
          this.hooks.log(`canvas agent ${this.identity.user.name}: opener ready in ${(performance.now() - t0).toFixed(0)} ms`);
        },
        (error: unknown) => {
          this.hooks.log(`canvas agent ${this.identity.user.name}: opener failed: ${error instanceof Error ? error.message : String(error)}`);
          if (stream.text === "") this.opener = null;
        },
      )
      .finally(() => {
        stream.close();
      });
  }

  /** Ends the session now: the summary, then `hooks.ended`. Resolves with the summary. */
  wrapUp(): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    clearTimeout(this.endTimer);
    this.enqueue({ kind: "close", done: resolve });
    return promise;
  }

  /** Stops listening (the room is gone); no summary. */
  dispose(): void {
    this.closed = true;
    clearTimeout(this.endTimer);
    clearTimeout(this.clearBubbleTimer);
    this.chat.unobserve(this.onChat);
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("change", this.onPresence);
  }

  private humans(): string[] {
    const out: string[] = [];
    for (const [cid, p] of this.awareness.getStates() as Map<number, Presence>) {
      if (cid !== this.awareness.clientID && p.user.kind === "human") out.push(p.user.name);
    }
    return out;
  }

  /** Plays the opener when the first human arrives; wraps up a while after the last one left. */
  private watchPresence(): void {
    if (this.closed) return;
    const n = this.humans().length;
    if (n > 0) {
      clearTimeout(this.endTimer);
      this.endTimer = undefined;
      if (!this.opened) {
        this.opened = true;
        this.enqueue({ kind: "open" });
      }
    } else if (this.hadHumans && this.endTimer === undefined) {
      this.endTimer = setTimeout(() => {
        this.endTimer = undefined;
        if (this.humans().length === 0) void this.wrapUp();
      }, this.options.endAfterMs);
    }
    this.hadHumans = n > 0;
  }

  private setP(patch: Partial<Presence>): void {
    this.presence = { ...this.presence, ...patch };
    if (!this.closed) this.awareness.setLocalState(this.presence);
  }

  private enqueue(turn: Turn): void {
    this.queue.push(turn);
    if (!this.busy) void this.loop();
  }

  private async loop(): Promise<void> {
    this.busy = true;
    for (let t = this.queue.shift(); t !== undefined; t = this.queue.shift()) {
      if (this.closed && t.kind !== "close") continue;
      try {
        if (t.kind === "message") await this.respond(t.msg.id, (onDelta) => this.brain(this.modelKey()).run(this.prompt(t.msg), onDelta), t.msg);
        else if (t.kind === "open") await this.open();
        else t.done(await this.close());
      } catch (error) {
        this.hooks.log(`canvas agent ${this.identity.user.name}: ${error instanceof Error ? error.message : String(error)}`);
        this.setP({ status: "idle", typing: null, connecting: null });
        if (t.kind === "close") t.done("");
      }
    }
    this.busy = false;
  }

  private openerPrompt(): string {
    const missing = ["agenda", "decisions"].filter((id) => !this.nodes.has(id));
    // Working notes go left of everything on the board.
    let minX = 0;
    let minY = 0;
    for (const id of this.nodes.keys()) {
      const b = this.box(id);
      if (b === null) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
    }
    const x = Math.round(minX - 560);
    const lines = [
      this.prompt(null),
      "",
      "# Session start",
      `${this.identity.human} just joined the canvas from our chat. Open like the conversation is resuming mid-stream, not a greeting. First @say: in plain words, where we left off in the chat on this board (what we were deciding or building, and where it stands), and that the open questions are going on the left. No "picking up" or "let's start" filler.`,
    ];
    if (missing.includes("agenda"))
      lines.push(`Then add the agenda: @add_node agenda note ${String(x)} ${String(Math.round(minY))} 480, title "Agenda", body 3 to 5 open questions for this session from the chat and the board, numbered "1 · ".`);
    if (missing.includes("decisions")) lines.push(`Then add @add_node decisions note ${String(x)} ${String(Math.round(minY + 560))} 480, title "Decisions", body "Nothing decided yet."`);
    lines.push('Finish with @point <the node the first open question is about>, then one @say asking that question, e.g. "First one: is a third panel tool right, or should this live in the popover?"');
    return lines.join("\n");
  }

  private async open(): Promise<void> {
    const opener = this.opener;
    this.opener = null;
    const id = `open-${Date.now().toString(36)}`;
    if (opener === null) {
      await this.respond(id, (onDelta) => this.brain(this.modelKey()).run(this.openerPrompt(), onDelta), null);
      return;
    }
    // Replays the precomputed opener (and whatever of it is still streaming in).
    await this.respond(
      id,
      async (onDelta) => {
        let at = 0;
        for (;;) {
          if (opener.text.length > at) {
            onDelta(opener.text.slice(at));
            at = opener.text.length;
          }
          if (opener.closed) return;
          await opener.changed();
        }
      },
      null,
    );
  }

  private async close(): Promise<string> {
    if (this.summary !== null) return this.summary;
    this.closed = true;
    clearTimeout(this.endTimer);
    const said = this.chat.toArray().filter((c) => c.kind === "human");
    let summary: string;
    if (said.length === 0) {
      summary = this.opened ? "Nothing was said at the canvas; the board is unchanged." : `${this.identity.human} did not join; the canvas session closed.`;
    } else {
      const prompt = [
        this.prompt(null),
        "",
        "# Session end",
        `The canvas session is ending. Write the note that goes back into our chat: 2 to 4 short plain sentences in your voice, what we worked on, what changed on the board, the decisions (from the Decisions note) and what is still open. Output plain text only, no @ lines.`,
      ].join("\n");
      this.setP({ status: "thinking", bubble: null, typing: null, connecting: null });
      let out = "";
      try {
        await this.brain(this.modelKey()).run(prompt, (d) => {
          out += d;
        });
      } catch (error) {
        this.hooks.log(`canvas agent ${this.identity.user.name}: summary failed: ${error instanceof Error ? error.message : String(error)}`);
        out = `The canvas session ended after ${String(said.length)} note${said.length === 1 ? "" : "s"}; the summary could not be written.`;
      }
      summary = out
        .replace(/^@say\s+/gm, "")
        .replace(/^@\w+.*$/gm, "")
        .replace(/\n{2,}/g, "\n")
        .trim();
    }
    const { user } = this.identity;
    this.chat.push([{ id: `wrap-${Date.now().toString(36)}`, kind: "event", name: user.name, color: user.color, text: `Wrapped up: ${summary}`, nodeIds: [], at: null, ts: Date.now() }]);
    this.setP({ status: "idle", bubble: null, typing: null, connecting: null, selected: [] });
    this.summary = summary;
    this.hooks.ended(summary);
    return summary;
  }

  private modelKey(): ModelKey {
    const model = this.doc.getMap(DOC_KEYS.settings).get("model");
    return model === "haiku" ? "haiku" : "sonnet";
  }

  private freeSpot(x: number, y: number, w: number, h: number): { x: number; y: number } {
    const pad = 40;
    const boxes = [...this.nodes.keys()].map((id) => this.box(id)).filter((b): b is Box => b !== null);
    const clear = (cx: number, cy: number): boolean => boxes.every((b) => cx + w + pad <= b.x || cx >= b.x + b.w + pad || cy + h + pad <= b.y || cy >= b.y + b.h + pad);
    if (clear(x, y)) return { x, y };
    // Rings of candidates around the requested spot, nearest first.
    for (let r = 60; r <= 2400; r += 60) {
      const candidates: [number, number][] = [
        [x + r, y],
        [x, y + r],
        [x - r, y],
        [x, y - r],
        [x + r, y + r],
        [x + r, y - r],
      ];
      for (const [cx, cy] of candidates) if (clear(cx, cy)) return { x: cx, y: cy };
    }
    return { x, y };
  }

  /** Where a node is: its own x/y, else where the layout puts it (as the clients draw it). */
  private box(id: string): Box | null {
    const m = this.nodes.get(id);
    if (!m) return null;
    let x = num(m, "x");
    let y = num(m, "y");
    if (x === undefined || y === undefined) {
      this.placed ??= this.layout();
      const at = this.placed.get(id);
      if (!at) return null;
      x = at.x;
      y = at.y;
    }
    const w = num(m, "w") ?? 240;
    const fallbackH = m.get("type") === "image" ? w * 0.75 + 40 : 160;
    return { x, y, w, h: num(m, "h") ?? fallbackH };
  }

  private layout(): Map<string, { x: number; y: number }> {
    const nodes: LayoutNode[] = [];
    for (const [id, m] of this.nodes) {
      const node: LayoutNode = { id, type: (m.get("type") ?? "note") as NodeKind, title: str(m, "title"), body: str(m, "body"), caption: str(m, "caption"), sample: str(m, "sample") };
      for (const k of ["x", "y", "w", "h"] as const) {
        const v = num(m, k);
        if (v !== undefined) node[k] = v;
      }
      const parent = m.get("parent");
      if (typeof parent === "string") node.parent = parent;
      nodes.push(node);
    }
    const edges = [...this.edges.values()].map((e) => ({ source: str(e, "source"), target: str(e, "target") }));
    const layout = this.doc.getMap(DOC_KEYS.meta).get("layout");
    return placeUnplaced(nodes, edges, layout === "grid" || layout === "tree" || layout === "flow" ? layout : undefined);
  }

  private async glide(tx: number, ty: number, onFrame?: (x: number, y: number) => void): Promise<void> {
    const from = { ...this.cursor };
    const dist = Math.hypot(tx - from.x, ty - from.y);
    const frame = this.options.frameMs ?? 33;
    const dur = frame === 0 ? 0 : Math.min(520, Math.max(160, 120 + dist * 0.16));
    const t0 = performance.now();
    for (;;) {
      const t = dur === 0 ? 1 : Math.min(1, (performance.now() - t0) / dur);
      const e = ease(t);
      this.cursor = { x: from.x + (tx - from.x) * e, y: from.y + (ty - from.y) * e };
      onFrame?.(this.cursor.x, this.cursor.y);
      this.setP({ cursor: this.cursor });
      if (t >= 1) return;
      await sleep(frame);
    }
  }

  /** One model turn: stream speech into the bubble and run actions as their lines complete. */
  private async respond(id: string, source: (onDelta: (delta: string) => void) => Promise<void>, msg: ChatMsg | null): Promise<void> {
    const t0 = performance.now();
    const modelKey = this.modelKey();
    clearTimeout(this.clearBubbleTimer);
    let firstToken = 0;
    const timing: { firstEdit: number | null } = { firstEdit: null };
    const markEdit = (): void => {
      timing.firstEdit ??= performance.now() - t0;
    };
    let said = "";
    let output = "";

    // React at once: think at the thing they pointed at, before the model answers.
    this.setP({ status: "thinking", replyTo: id, bubble: null, typing: null, connecting: null, selected: [] });
    const anchorId = msg?.nodeIds[0];
    const anchor = anchorId === undefined ? null : this.box(anchorId);
    const target = anchor ? { x: anchor.x + anchor.w - 30, y: anchor.y + 26 } : msg?.at ? { x: msg.at.x + 70, y: msg.at.y + 50 } : this.cursor;
    let exec: Promise<void> = this.glide(target.x, target.y);
    const cursorMs = performance.now() - t0;

    const parser = new ActionParser(
      (a) => {
        exec = exec.then(() => this.run(a, markEdit)).catch((error: unknown) => {
          this.hooks.log(`canvas agent action ${a.kind}: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      (chunk) => {
        said += chunk;
        this.setP({ bubble: { text: said, replyTo: id, streaming: true } });
      },
    );
    try {
      await source((delta) => {
        if (firstToken === 0) firstToken = performance.now() - t0;
        output += delta;
        parser.feed(delta);
      });
    } finally {
      parser.finish();
    }
    const modelDone = performance.now() - t0;
    await exec;
    const done = performance.now() - t0;

    const { user } = this.identity;
    this.setP({ status: "idle", typing: null, connecting: null, bubble: { text: said, replyTo: id, streaming: false } });
    this.chat.push([{ id: `a-${id}`, kind: "agent", name: user.name, color: user.color, text: said, nodeIds: [], at: { ...this.cursor }, ts: Date.now(), replyTo: id, model: modelKey }]);
    const server: ServerMetrics = { model: modelKey, cursor: cursorMs, firstToken, firstEdit: timing.firstEdit, modelDone, done, output };
    this.doc.getMap(DOC_KEYS.metrics).set(`s:${id}`, server);
    this.hooks.log(
      `canvas agent ${user.name} ${modelKey} ${msg === null ? "opener" : "turn"}: cursor=${cursorMs.toFixed(1)}ms first=${firstToken.toFixed(0)}ms edit=${timing.firstEdit === null ? "-" : timing.firstEdit.toFixed(0)}ms model=${modelDone.toFixed(0)}ms done=${done.toFixed(0)}ms`,
    );
    this.clearBubbleTimer = setTimeout(() => {
      this.setP({ bubble: null, selected: [] });
    }, 8000);
    if (msg !== null) this.hooks.turn({ name: msg.name, text: msg.text }, said);
  }

  private async run(a: Action, markEdit: () => void): Promise<void> {
    if (this.closed) return;
    const transact = (fn: () => void): void => {
      this.doc.transact(fn, AGENT_ORIGIN);
      markEdit();
    };
    switch (a.kind) {
      case "point": {
        const b = this.box(a.id);
        if (!b) return;
        this.setP({ status: "moving" });
        await this.glide(b.x + Math.min(b.w - 30, 180), b.y + Math.min(b.h - 10, 40));
        return;
      }
      case "select": {
        const b = this.box(a.id);
        if (!b) return;
        this.setP({ status: "moving" });
        await this.glide(b.x + b.w - 30, b.y + 26);
        this.setP({ selected: [a.id] });
        return;
      }
      case "set_text":
      case "append_text": {
        const b = this.box(a.id);
        const yt = this.nodes.get(a.id)?.get(a.field);
        if (!b || !(yt instanceof Y.Text)) return;
        this.setP({ status: "moving" });
        await this.glide(b.x + 40, b.y + (a.field === "title" ? 24 : 60));
        if (a.kind === "set_text") {
          this.setP({ selected: [a.id], status: "typing", typing: { nodeId: a.id, field: a.field, index: 0, selectAll: true } });
          await sleep(this.options.typeMs === 0 ? 0 : 140);
          transact(() => {
            yt.delete(0, yt.length);
          });
        } else {
          this.setP({ selected: [a.id], status: "typing" });
          if (yt.length > 0) {
            transact(() => {
              yt.insert(yt.length, "\n");
            });
          }
        }
        await this.type(a.id, [a.field], a.text, markEdit);
        return;
      }
      case "add_node": {
        // Models misjudge free space; nudge the spot until it clears every node.
        const spot = this.freeSpot(a.x, a.y, a.w, 220);
        this.setP({ status: "moving" });
        await this.glide(spot.x + 30, spot.y + 24);
        const m = new Y.Map<unknown>();
        m.set("type", a.type);
        m.set("x", Math.round(spot.x));
        m.set("y", Math.round(spot.y));
        m.set("w", Math.round(a.w));
        m.set("title", new Y.Text(""));
        m.set("body", new Y.Text(""));
        m.set("fields", []);
        transact(() => {
          this.nodes.set(a.id, m);
        });
        this.setP({ selected: [a.id], status: "typing" });
        await this.type(a.id, ["title", "body"], a.text, markEdit);
        return;
      }
      case "move_node": {
        const b = this.box(a.id);
        const m = this.nodes.get(a.id);
        if (!b || !m) return;
        this.setP({ status: "moving" });
        await this.glide(b.x + 30, b.y + 20);
        this.setP({ selected: [a.id] });
        await this.glide(a.x + 30, a.y + 20, (x, y) => {
          transact(() => {
            m.set("x", Math.round(x - 30));
            m.set("y", Math.round(y - 20));
          });
        });
        return;
      }
      case "add_edge": {
        const s = this.box(a.source);
        const t = this.box(a.target);
        if (!s || !t) return;
        const horizontal = Math.abs(t.x + t.w / 2 - (s.x + s.w / 2)) > Math.abs(t.y + t.h / 2 - (s.y + s.h / 2));
        const [sh, th] = horizontal ? (t.x > s.x ? ["right", "left"] : ["left", "right"]) : t.y > s.y ? ["bottom", "top"] : ["top", "bottom"];
        const port = (b: Box, h: string): { x: number; y: number } =>
          h === "right" ? { x: b.x + b.w, y: b.y + b.h / 2 } : h === "left" ? { x: b.x, y: b.y + b.h / 2 } : h === "bottom" ? { x: b.x + b.w / 2, y: b.y + b.h } : { x: b.x + b.w / 2, y: b.y };
        const sp = port(s, sh);
        const tp = port(t, th);
        this.setP({ status: "moving" });
        await this.glide(sp.x, sp.y);
        this.setP({ status: "drawing", connecting: { source: a.source } });
        await this.glide(tp.x, tp.y);
        const e = new Y.Map<unknown>();
        e.set("source", a.source);
        e.set("target", a.target);
        e.set("sourceHandle", sh);
        e.set("targetHandle", th);
        if (a.label !== "") e.set("label", a.label);
        transact(() => {
          this.edges.set(`e-${a.source}-${a.target}`, e);
        });
        this.setP({ connecting: null });
        return;
      }
      case "delete": {
        const b = this.box(a.id);
        if (!b) return;
        this.setP({ status: "moving" });
        await this.glide(b.x + b.w - 30, b.y + 26);
        this.setP({ selected: [a.id] });
        await sleep(this.options.typeMs === 0 ? 0 : 250);
        transact(() => {
          this.nodes.delete(a.id);
          for (const [eid, e] of this.edges) if (e.get("source") === a.id || e.get("target") === a.id) this.edges.delete(eid);
        });
        this.setP({ selected: [] });
        return;
      }
    }
  }

  /** Types streamed text into one or more fields; a newline in a non-final field advances to the next. */
  private async type(nodeId: string, fields: TextField[], stream: TextStream, markEdit: () => void): Promise<void> {
    let fi = 0;
    let consumed = 0;
    const textOf = (f: TextField | undefined): Y.Text | null => {
      const t = f === undefined ? null : this.nodes.get(nodeId)?.get(f);
      return t instanceof Y.Text ? t : null;
    };
    const first = textOf(fields[0]);
    if (!first) return;
    let yt: Y.Text = first;
    let rel = Y.createRelativePositionFromTypeIndex(yt, yt.length);
    this.setP({ status: "typing", typing: { nodeId, field: fields[0] ?? "body", index: yt.length } });
    for (;;) {
      const backlog = stream.text.length - consumed;
      if (backlog === 0) {
        if (stream.closed) break;
        await stream.changed();
        continue;
      }
      // Faster than a person, and it catches up when the model outruns the typist.
      let n = Math.min(backlog, Math.max(3, Math.ceil(backlog / 8)));
      let chunk = stream.text.slice(consumed, consumed + n);
      const nl = chunk.indexOf("\n");
      const advance = nl >= 0 && fi < fields.length - 1;
      if (advance) {
        chunk = chunk.slice(0, nl);
        n = nl + 1;
      }
      const idx = Y.createAbsolutePositionFromRelativePosition(rel, this.doc)?.index ?? yt.length;
      const target = yt;
      if (chunk !== "") {
        this.doc.transact(() => {
          target.insert(idx, chunk);
        }, AGENT_ORIGIN);
        markEdit();
      }
      consumed += n;
      rel = Y.createRelativePositionFromTypeIndex(yt, idx + chunk.length);
      if (advance) {
        fi++;
        const next = textOf(fields[fi]);
        if (!next) return;
        yt = next;
        rel = Y.createRelativePositionFromTypeIndex(yt, yt.length);
      }
      this.setP({ typing: { nodeId, field: fields[fi] ?? "body", index: Y.createAbsolutePositionFromRelativePosition(rel, this.doc)?.index ?? 0 } });
      await sleep(this.options.typeMs ?? 16);
    }
    this.setP({ typing: null });
  }

  /** Per-turn context: purpose, full board, who is here and their selections, recent chat, the note. */
  private prompt(msg: ChatMsg | null): string {
    const lines: string[] = [];
    const title = str(this.doc.getMap(DOC_KEYS.meta), "title") || "Board";
    lines.push("# Board purpose", `Title: ${title}`);
    if (this.identity.purpose !== "") lines.push(`Session goal: ${this.identity.purpose}`);
    for (const [id, m] of this.nodes) {
      if (m.get("type") === "topic" || /how to read/i.test(str(m, "title"))) lines.push(`- ${id}: ${str(m, "title")}. ${str(m, "body").split("\n")[0] ?? ""}`);
    }

    lines.push("", "# Full board", "Coordinates in px, x grows right, y grows down. Each node: [id] type @x,y w×h, then title and full body.");
    for (const [id, m] of this.nodes) {
      const b = this.box(id);
      if (!b) continue;
      const type = str(m, "type");
      const parent = m.get("parent");
      lines.push(`[${id}] ${type} @${String(Math.round(b.x))},${String(Math.round(b.y))} ${String(Math.round(b.w))}×${String(Math.round(b.h))}${typeof parent === "string" ? ` in frame ${parent}` : ""}`, `title: ${str(m, "title")}`);
      if (type === "image") lines.push(`image: ${str(m, "src")} (caption: ${str(m, "caption")})`);
      for (const k of ["key", "status", "pr", "url", "caption", "font", "sample"]) if (type !== "image" && str(m, k) !== "") lines.push(`${k}: ${str(m, k)}`);
      const colors = m.get("colors");
      if (Array.isArray(colors) && colors.length > 0) lines.push(`colors: ${(colors as { hex: string; name?: string }[]).map((c) => (c.name === undefined ? c.hex : `${c.name} ${c.hex}`)).join(", ")}`);
      if (str(m, "body") !== "") lines.push(`body:\n${str(m, "body")}`);
      lines.push("");
    }
    lines.push("# Edges");
    for (const [, e] of this.edges) {
      const label = e.get("label");
      lines.push(`${String(e.get("source"))} -> ${String(e.get("target"))}${typeof label === "string" && label !== "" ? ` "${label}"` : ""}`);
    }

    lines.push("", "# People here now");
    for (const [cid, p] of this.awareness.getStates() as Map<number, Presence>) {
      if (cid === this.awareness.clientID) continue;
      const sel = p.selected?.length ? `selected: ${p.selected.join(", ")}` : "nothing selected";
      const at = p.cursor ? `, cursor @${String(Math.round(p.cursor.x))},${String(Math.round(p.cursor.y))}` : "";
      lines.push(`- ${p.user.name}: ${sel}${at}`);
    }

    const recent = this.chat
      .toArray()
      .filter((c) => c.id !== msg?.id && c.kind !== "event")
      .slice(-12);
    lines.push("", "# Recent cursor chat (oldest first)");
    if (recent.length === 0) lines.push("(none yet)");
    for (const c of recent) lines.push(`${c.name}${c.nodeIds.length > 0 ? ` [on ${c.nodeIds.join(", ")}]` : ""}: ${c.text}`);

    if (msg) {
      lines.push("", "# This note");
      lines.push(msg.nodeIds.length > 0 ? `Attached nodes (selected when sent): ${msg.nodeIds.join(", ")}` : "No node attached.");
      if (msg.at) lines.push(`Sent at cursor @${String(Math.round(msg.at.x))},${String(Math.round(msg.at.y))}.`);
      lines.push(`${msg.name} says: ${msg.text}`);
    }
    return lines.join("\n");
  }
}
