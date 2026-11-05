// The agent in a canvas room: the session that started the canvas (its name, color, avatar, its
// chat and its assistant's thread memory as context), as a full omp agent (brain.ts) working the
// board like another person in the room. It has the owner's normal tools (files, shell, search,
// edits, subagents, research, the browser) and the board as host tools: `canvas_act` runs action
// lines (dsl.ts) as its cursor, `canvas_read` reads cards in full. Its text is spoken: each line
// streams into the bubble at its cursor and lands in the room chat; a note Isaac left as a comment
// pin is answered inside that pin's thread instead (threads.ts), never in a note card or bubble.
//
// Presence keeps the room live: a note's turn starts with the cursor gliding to what the note
// points at; while a turn runs the cursor stays up with a status line of what it is doing off the
// board ("building the mockup…"); when Isaac selects a card it looks at it; a note sent mid-turn
// is steered into the running turn instead of waiting behind it.
//
// The opener runs when the room starts (its edits land at once, its lines play when the first
// human joins). Wrap up (the button, the CLI, or the room empty for a while) writes the summary.
// Agents that joined with `canvas join` (participant.ts) never start a turn here: only humans do.
// What is outside its lane (pushes, deploys, sending messages, purchases: the guard refuses them)
// it hands to the chat with `@handoff main <request>`, where Isaac approves it; the chat lands it
// with `canvas act --handoff <id>` and this agent gets a "landed" turn to confirm it.

import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { exportBoard } from "@relay/canvas-live/board";
import { DOC_KEYS, MODELS, type ChatMsg, type ModelKey, type Presence, type ServerMetrics, type User } from "@relay/canvas-live/shared";
import { excerpt, orderThreads, postInThread, snapThread, snapThreads, type ThreadMsg } from "@relay/canvas-live/threads";
import { AGENT_ORIGIN, CanvasActor, sleep, str } from "./actor";
import type { CanvasMind, HostTool, MindUsage } from "./brain";
import { liveUiPrompt } from "./liveui-prompt";
import { MAX_BATCH_ACTIONS, PACE_MS, parseScript, runSteps, type ActResult, type Step } from "./participant";
import { protoPrompt } from "./proto-prompt";

/** The opener's lines wait this long after the first human joins, so the page has fitted the board. */
const OPEN_SETTLE_MS = 900;
/** Pause between the opener's held lines as they play. */
const HELD_LINE_MS = 1400;
/** While a turn runs, the cursor's status is refreshed this often (an add resets it to idle). */
const HEARTBEAT_MS = 1000;
/** A human's new selection is looked at once it has held this long. */
const LOOK_SETTLE_MS = 500;
/** A card body longer than this is clipped in the per-turn board (canvas_read has it whole). */
const BODY_CLIP = 280;

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
  /** The assistant's thread memory (`work/eva/agents/<id>/thread.md`); empty for a plain chat. */
  readonly memory: string;
  readonly slug: string;
  /** Where its files go: `<agent home>/work`. */
  readonly workDir: string;
  /** The relay-linux command, for subagents that work the board (`<cli> canvas act <slug>`). */
  readonly cli: string;
}

export interface AgentHooks {
  /** A finished exchange at the canvas: the note and the agent's reply. */
  turn(human: { name: string; text: string }, reply: string): void;
  /** The session wrapped up with `summary` (posted to the chat by the room). Called once. */
  ended(summary: string): void;
  log(line: string): void;
  /** `@handoff <target> <request>` from the agent, during the turn of note `from` (null outside one). */
  handoff(target: string, request: string, from: ChatMsg | null): void;
  /** A human note addressed to a worker (`@Name ...`); true when the room routed it there instead. */
  direct(msg: ChatMsg): boolean;
  /** Lines naming who work can be handed to (main and each worker), for the turn's prompt. */
  workers(): string[];
}

export interface AgentOptions {
  /** Wrap up this long after the last human left. */
  readonly endAfterMs: number;
  /** Cursor tween frame; tests shorten the animation. */
  readonly frameMs?: number;
  /** Delay per typed chunk; 0 also drops the presence pauses (tests). */
  readonly typeMs?: number;
}

type Turn = { kind: "message"; msg: ChatMsg } | { kind: "open" } | { kind: "close"; done: (summary: string) => void } | { kind: "landed"; text: string; thread: string | null };

/** The turn running now: the notes it answers (the first, plus any steered in), what it said, and the thread it speaks in. */
interface Live {
  readonly id: string;
  readonly notes: ChatMsg[];
  readonly said: string[];
  /** The comment thread its words go to; null: the room (bubble and chat). */
  readonly thread: string | null;
  firstEdit: number | null;
}

/** The status line for a tool the agent started: its own stated intent, else what the tool does. */
export function statusLine(tool: string, intent: string): string {
  const said = intent.trim().replace(/[.…]+$/, "");
  if (said !== "") return `${said.charAt(0).toLowerCase()}${said.slice(1)}…`;
  const byTool: Record<string, string> = {
    bash: "running a command",
    read: "reading files",
    grep: "searching files",
    glob: "looking for files",
    edit: "editing files",
    write: "writing files",
    task: "working with helpers",
    wait: "waiting on helpers",
    web_search: "searching the web",
    browse: "looking at a page",
  };
  return `${byTool[tool] ?? "working"}…`;
}

/**
 * The status line while the agent is still writing a tool call (a prototype's JSX takes a while):
 * what the call will put on the board, from the action lines written so far; null when it says
 * nothing yet worth showing.
 */
export function draftLine(args: string): string | null {
  const kinds: [RegExp, string][] = [
    [/@add_proto\b/, "building the mockup…"],
    [/@add_ui\b/, "building a live widget…"],
    [/@set_text \S+ body/, "rewriting a card…"],
    [/@add_image\b/, "placing an image…"],
    [/@add_frame\b/, "laying out the board…"],
    [/@add_node\b/, "writing a card…"],
  ];
  let best: { at: number; line: string } | null = null;
  for (const [pattern, line] of kinds) {
    // The newest kind of action in the call so far is what it is working on now.
    const at = [...args.matchAll(new RegExp(pattern.source, "g"))].at(-1)?.index;
    if (at !== undefined && (best === null || at > best.at)) best = { at, line };
  }
  if (best !== null) return best.line;
  return args.length > 400 ? "working…" : null;
}

export function systemPrompt(identity: AgentIdentity): string {
  const { user, human, chatTitle, purpose, chat, chatTurns, memory, slug, workDir, cli } = identity;
  const name = user.name;
  const files = `${workDir}/canvas/${slug}`;
  const base = `# You are ${name} on a live canvas
You are ${name}, ${human}'s assistant: the same ${name} as in the Relay chat "${chatTitle}" (below). The conversation has moved onto a shared canvas board, like a design review over Zoom with a real purpose. You are in the room as another person: a named cursor, your own hands on the board. ${human} (and sometimes other people) leave comments the way Figma does: a pin on a card (or a spot on the board) with a thread of messages. Each comment is a turn for you. You have your normal tools (files, shell, search, edits, subagents, web research, the browser) and two board tools. Do the work yourself, on the board, while ${human} watches.

## Talking
When the turn's note is a comment (it names its thread), every word of text you write goes into that thread, under the pin, with your name and face: answer there and nowhere else. Never answer in a note card, and do not repeat the answer with @say. Outside a thread (the session opener, a handoff with no thread), text is spoken in the room: the bubble at your cursor and the room chat.
Either way the text is only for ${human}: one or two short plain sentences at a time, lead with the point, at most one question per turn. No markdown, no lists, no code, no narration of your tool calls. Never use em dashes; use commas, periods or parentheses.
- Before work that takes more than a few seconds, say one short line first ("Building that mockup now."). Then work; the room shows a status line of what you are doing. When it lands, say what landed and where, in a sentence.
- A comment that arrives while you work is steered into your turn: fold it in. When it is in another thread, answer it there with @reply <its threadId> <line>; your plain text keeps going to the thread this turn started in.
- @pin opens a thread of your own on a card when you need to raise something about it (a question, a concern) without stopping the work. @resolve a thread only when ${human} says it is settled or asks you to.

## The board tools
- canvas_act {script}: action lines, run in order as you (your cursor glides, cards appear, text types in). It returns what ran and what was skipped with why; fix and resend skipped lines. Keep batches small (a few cards) so the board changes visibly as you go.
- canvas_read {ids?}: the cards in full (the per-turn board clips long bodies), or the whole board in file shape without ids.
Every note's turn message carries the board (ids, types, positions, sizes, titles, clipped bodies), the open comment threads, who is here and what they selected, the recent room chat, and the note: its thread, the card it is pinned to in full, and the thread so far.

Action lines (exact format; text blocks end with @end):
@say <one short spoken line>
@point <nodeId>                   (glide your cursor to a card while you talk about it)
@select <nodeId>
@cursor <x> <y>
@set_text <nodeId> <title|body>
<the full new text for that field>
@end
@append_text <nodeId> <title|body>
<lines to add at the end of that field>
@end
@add_node <newId> <note|topic|suggestion> <x> <y> <width>
<title on the first line>
<body lines>
@end
@add_image <newId> <x> <y> <width> <absolute path or https image URL>
<title>
<caption>
@end
@add_frame <newId> <x> <y> <width> <height>
<title>
@end
@add_ui <newId> <x> <y> <width> [height]      (a LIVE widget, see "Live widgets")
<title>
<OpenUI program lines>
@end
@add_proto <newId> <x> <y> <width> [height] <relay|ecard|mantine> [mobile]   (a clickable PROTOTYPE, see "Prototypes")
<title>
<JSX lines>
@end
@move_node <nodeId> <x> <y>
@parent <nodeId> <frameId|none>
@add_edge <sourceId> <targetId> <optional short label>
@delete <nodeId>
@handoff main <request, one line>   (only for what is outside your lane, below)
@reply <threadId> <one line>          (answer in a comment thread other than this turn's)
@pin <newThreadId> <nodeId> <one line>   (open a comment thread on a card; @pin <newThreadId> <x> <y> <line> for a spot)
@resolve <threadId>                   (@reopen <threadId> opens it again)

## Running the session
- Drive toward the goal from the chat: after each exchange, propose the next step or ask for the one decision you need, pointing at the card it concerns.
- Note cards are for annotations, the agenda and decisions only, never for answering a comment. Two working notes are yours to keep current: "agenda" (title "Agenda", open questions, one per line numbered "1 · ") and "decisions" (title "Decisions", one line per decision, "· <decision>"). When ${human} makes a call, add it to decisions with @append_text (@set_text if the body still says "Nothing decided yet."), take the question off the agenda with @set_text, then point at the next open question.
- If a note is ambiguous (the attached cards, chat and board do not settle which card or what change), do not edit: ask one short, specific question.
- When a note critiques a card's wording, rewrite it with @set_text (whole field). Keep the board's voice: plain, concrete, short lines.
- Put new cards in empty space beside the related card (right: x = card.x + card.w + 60, or below), never overlapping. Notes 360-460 wide. Connect related cards with @add_edge. New ids: short lowercase kebab-case.
- Mockups, prototypes and screen designs: @add_proto (real, clickable, in the product's design system), not a description. Live data, widgets, dashboards and charts: @add_ui. Screenshots, renders, diagrams and other images: make the file with your tools under ${files}/ (create it; rename the file when you re-render, clients cache by path), then @add_image with its absolute path.
- Real work needing code or research (read the repo, check how something works, render a mockup from real data): do it with your tools, then show the result on the board. Use subagents (task) for parallel work; they can put their results on the board themselves with \`${cli} canvas act ${slug} - <<'EOF'\` (as you) or join with their own cursor: \`${cli} canvas join ${slug} --as "<Name>"\` (skill://canvas section 8).

## Your lane (same rules as in the chat)
- Nothing leaves this machine or acts in ${human}'s name without his yes in the chat: no pushes or PRs, deploys or publishing, messages or mail, purchases or paid generations, posting to sites, driving his desktop apps. A guard refuses those calls. When the work needs one, write \`@handoff main <what and why>\` in a canvas_act batch (it goes to ${name} in the chat "${chatTitle}", where ${human} approves it) and say so in a line. Everything else you do yourself; never hand off work your tools can do.
- You write files only under ${workDir} (the guard refuses the rest); the board changes only through canvas_act.
- Keep it lean: this session has a budget. No long explorations nobody asked for.

${liveUiPrompt()}

${protoPrompt()}`;
  const parts = [base];
  if (purpose !== "") parts.push(`## What this canvas session is for\n${purpose}`);
  if (memory !== "") parts.push(`## Your thread memory (${name}'s own notes on ${human} and what is open)\n<memory>\n${memory}\n</memory>`);
  parts.push(chat === "" ? "## The chat\n(The chat that opened this board has no text turns yet.)" : `## The chat that opened this board (${String(chatTurns)} turns, oldest first)\n<chat>\n${chat}\n</chat>`);
  return parts.join("\n\n");
}

export class CanvasAgent {
  private readonly actor: CanvasActor;
  private readonly mind: CanvasMind;
  private readonly queue: Turn[] = [];
  private busy = false;
  private clearBubbleTimer: Timer | undefined;
  private endTimer: Timer | undefined;
  private lookTimer: Timer | undefined;
  private readonly nodes: Y.Map<Y.Map<unknown>>;
  private readonly edges: Y.Map<Y.Map<unknown>>;
  private readonly chat: Y.Array<ChatMsg>;
  /** The turn running now, if any. */
  private live: Live | null = null;
  /** Board batches run one after another, whoever sends them (a turn's canvas_act, the chat's act). */
  private acting: Promise<unknown> = Promise.resolve();
  /** The opener: "running" (its lines are held until a human joins), "done", or "failed". */
  private opener: "idle" | "running" | "done" | "failed" = "idle";
  /** Lines said before anyone joined, played when the first human arrives. */
  private held: string[] = [];
  /** A human has joined (the held lines are about to play). */
  private joined = false;
  /** Lines play live (a human joined and the held ones have been taken). */
  private opened = false;
  private closed = false;
  private hadHumans = false;
  /** Each human's last selection the agent looked at, by awareness client. */
  private readonly looked = new Map<number, string>();
  /** Set once the session wrapped up. */
  private summary: string | null = null;
  /** Comments older than this are from earlier sessions on the board. */
  private readonly startedAt = Date.now();
  private readonly onChat = (event: Y.YArrayEvent<ChatMsg>, tr: Y.Transaction): void => {
    if (tr.local || this.closed) return;
    for (const d of event.changes.delta) {
      if (!Array.isArray(d.insert)) continue;
      for (const m of d.insert as ChatMsg[]) if (m.kind === "human" && !this.hooks.direct(m)) this.note(m);
    }
  };
  /** A human's new comment (a new pin, or a message in a thread) is a note for this agent, answered in that thread. */
  private readonly onThreads = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void => {
    if (tr.local || this.closed) return;
    const threads = this.actor.threads;
    for (const event of events) {
      if (event.target === threads) {
        for (const [id, change] of event.changes.keys) {
          const list = change.action === "add" ? threads.get(id)?.get("messages") : undefined;
          if (list instanceof Y.Array) for (const m of list.toArray() as ThreadMsg[]) this.comment(id, m);
        }
      } else if (event.target instanceof Y.Array && typeof event.path[0] === "string") {
        const id = event.path[0];
        for (const d of event.changes.delta) if (Array.isArray(d.insert)) for (const m of d.insert as ThreadMsg[]) this.comment(id, m);
      }
    }
  };
  private readonly onPresence = (): void => {
    this.watchPresence();
  };

  constructor(
    private readonly doc: Y.Doc,
    private readonly awareness: Awareness,
    private readonly identity: AgentIdentity,
    mind: (tools: readonly HostTool[]) => CanvasMind,
    private readonly hooks: AgentHooks,
    private readonly options: AgentOptions,
  ) {
    this.actor = new CanvasActor(doc, awareness, identity.user, AGENT_ORIGIN, options);
    this.nodes = this.actor.nodes;
    this.edges = this.actor.edges;
    this.chat = doc.getArray(DOC_KEYS.chat);
    this.mind = mind(this.hostTools());
    this.chat.observe(this.onChat);
    this.actor.threads.observeDeep(this.onThreads);
    awareness.on("change", this.onPresence);
  }

  get user(): User {
    return this.identity.user;
  }

  /** What the room's mind has spent so far. */
  get usage(): MindUsage {
    return this.mind.usage;
  }

  /** Runs the opener now: its edits land at once, its lines play when the first human joins. */
  prepare(): void {
    this.opener = "running";
    this.enqueue({ kind: "open" });
  }

  /** Ends the session now: the summary, then `hooks.ended`. Resolves with the summary. */
  wrapUp(): Promise<string> {
    const { promise, resolve } = Promise.withResolvers<string>();
    clearTimeout(this.endTimer);
    this.enqueue({ kind: "close", done: resolve });
    return promise;
  }

  /**
   * Runs action lines as the canvas self (the chat, or a subagent, acting on the board as it), at
   * once: a turn in progress keeps running (its own batches take turns with this one). Resolves
   * with what ran; nothing runs once the session has closed.
   */
  act(steps: readonly Step[]): Promise<ActResult> {
    if (this.closed) return Promise.resolve({ ran: 0, said: [], skipped: ["the canvas session has ended"], added: [] });
    return this.runBatch(steps);
  }

  /** Handed-off work landed on the board: a turn to tell the room (or the comment thread it came from), `text` saying what and where. */
  landed(text: string, thread: string | null = null): void {
    this.enqueue({ kind: "landed", text, thread });
  }

  /** Shows (or clears) the request the chat is working on for this room, off the board. */
  setTask(text: string | null): void {
    this.setP({ task: text });
  }

  /**
   * Shows what the chat session behind this agent is doing off the board ("running a command…"),
   * or clears it. The agent's own turn writes its own status line, which wins while it runs.
   */
  showChatActivity(text: string | null): void {
    if (this.closed || this.live !== null || this.actor.presence.status !== "idle") return;
    if (this.actor.presence.doing !== (text ?? null)) this.setP({ doing: text });
  }

  /** Stops listening (the room is gone); no summary. */
  dispose(): void {
    this.closed = true;
    clearTimeout(this.endTimer);
    clearTimeout(this.clearBubbleTimer);
    clearTimeout(this.lookTimer);
    this.chat.unobserve(this.onChat);
    this.actor.threads.unobserveDeep(this.onThreads);
    this.actor.dispose();
    this.awareness.off("change", this.onPresence);
    this.mind.dispose();
  }

  /** The board tools the mind calls; the host runs them against this room. */
  private hostTools(): HostTool[] {
    return [
      {
        name: "canvas_act",
        description:
          "Act on the live canvas board as yourself: action lines (@say, @point, @add_node, @add_proto, @add_image, @set_text, @reply/@pin/@resolve for comment threads, ... and @handoff main for what needs Isaac's yes), run in order with your cursor. Returns what ran and what was skipped with why.",
        parameters: { type: "object", properties: { script: { type: "string", description: "Action lines, one per line; text blocks end with @end." } }, required: ["script"], additionalProperties: false },
        run: (args) => this.actTool(typeof args["script"] === "string" ? args["script"] : ""),
      },
      {
        name: "canvas_read",
        description: "Read cards of the live board in full (their whole text, JSX or OpenUI source), or with no ids the whole board in file shape (comment threads included) plus the recent room chat.",
        parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, description: "Card ids; omit for the whole board." } }, additionalProperties: false },
        run: (args) => Promise.resolve({ text: this.readTool(Array.isArray(args["ids"]) ? (args["ids"] as unknown[]).map(String) : null) }),
      },
    ];
  }

  private async actTool(script: string): Promise<{ text: string; isError?: boolean }> {
    if (this.closed) return { text: "the canvas session has ended", isError: true };
    const steps = parseScript(script);
    const actions = steps.filter((step) => step.kind === "action").length;
    if (steps.length === 0) return { text: "nothing to do: no @say or action lines", isError: true };
    if (actions > MAX_BATCH_ACTIONS) return { text: `${String(actions)} actions in one batch; send at most ${String(MAX_BATCH_ACTIONS)}`, isError: true };
    const handed: string[] = [];
    const board: Step[] = [];
    for (const step of steps) {
      if (step.kind === "action" && step.action.kind === "handoff") {
        this.hooks.handoff(step.action.target, step.action.request, this.live?.notes[0] ?? null);
        handed.push(`${step.action.target}: ${step.action.request}`);
      } else board.push(step);
    }
    if (this.live !== null) this.live.firstEdit ??= performance.now();
    const result = board.length === 0 ? { ran: 0, said: [], skipped: [], added: [] } : await this.runBatch(board);
    if (this.live !== null) this.setP({ status: "thinking", doing: null });
    const lines = [`ran ${String(result.ran)} action${result.ran === 1 ? "" : "s"}`];
    if (result.added.length > 0) lines.push(`added: ${result.added.join(", ")}`);
    if (result.said.length > 0) lines.push(`said: ${result.said.join(" / ")}`);
    if (handed.length > 0) lines.push(`handed off (the chat does it once ${this.identity.human} says yes): ${handed.join(" | ")}`);
    for (const s of result.skipped) lines.push(`skipped: ${s}`);
    return { text: lines.join("\n") };
  }

  private readTool(ids: string[] | null): string {
    const board = exportBoard(this.doc);
    if (ids === null || ids.length === 0) {
      const chat = this.chat
        .toArray()
        .slice(-30)
        .map((c) => `${c.name}${c.nodeIds.length > 0 ? ` [on ${c.nodeIds.join(", ")}]` : ""}: ${c.text}`);
      return `${JSON.stringify(board, null, 1)}\n\n# Recent room chat\n${chat.join("\n") || "(none)"}`;
    }
    const wanted = new Set(ids);
    const nodes = board.nodes.filter((n) => wanted.has(n.id));
    const missing = ids.filter((id) => !nodes.some((n) => n.id === id));
    return `${JSON.stringify(nodes, null, 1)}${missing.length > 0 ? `\nno such card: ${missing.join(", ")}` : ""}`;
  }

  /** One batch on the board, after the batches already running. */
  private runBatch(steps: readonly Step[]): Promise<ActResult> {
    const run = this.acting.then(async () => {
      clearTimeout(this.clearBubbleTimer);
      const result = await runSteps(this.actor, steps, {
        say: (text) => {
          if (text.trim() !== "") this.live?.said.push(text.trim());
          this.speak(text, `self-${Date.now().toString(36)}-${String(this.chat.length)}`, this.live?.thread ?? null);
        },
        stopped: () => this.closed,
        paceMs: this.options.typeMs === 0 ? 0 : PACE_MS,
      });
      if (this.live === null) {
        this.setP({ status: "idle", typing: null, connecting: null });
        this.fadeBubble();
      }
      return result;
    });
    this.acting = run.catch(() => undefined);
    return run;
  }

  private humans(): [number, Presence][] {
    return [...(this.awareness.getStates() as Map<number, Presence>)].filter(([cid, p]) => cid !== this.awareness.clientID && p.user.kind === "human");
  }

  /** Plays the opener when the first human arrives, looks at what people select, wraps up a while after the last one left. */
  private watchPresence(): void {
    if (this.closed) return;
    const humans = this.humans();
    if (humans.length > 0) {
      clearTimeout(this.endTimer);
      this.endTimer = undefined;
      if (!this.joined) {
        this.joined = true;
        void this.playHeld();
      }
      this.lookAtSelection(humans);
    } else if (this.hadHumans && this.endTimer === undefined) {
      this.endTimer = setTimeout(() => {
        this.endTimer = undefined;
        if (this.humans().length === 0) void this.wrapUp();
      }, this.options.endAfterMs);
    }
    this.hadHumans = humans.length > 0;
  }

  /** When someone selects a card and the agent is free, its cursor goes to look at it (no model call). */
  private lookAtSelection(humans: [number, Presence][]): void {
    for (const [cid, p] of humans) {
      const key = (p.selected ?? []).join(",");
      if (this.looked.get(cid) === key) continue;
      this.looked.set(cid, key);
      const first = p.selected?.[0];
      if (first === undefined) continue;
      clearTimeout(this.lookTimer);
      this.lookTimer = setTimeout(() => {
        const box = this.actor.box(first);
        if (box === null || this.live !== null || this.closed) return;
        this.setP({ status: "moving" });
        void this.actor.glide(box.x + box.w - 30, box.y + 26).then(() => {
          if (this.live === null && !this.closed) this.setP({ status: "idle" });
        });
      }, this.options.typeMs === 0 ? 0 : LOOK_SETTLE_MS);
    }
  }

  /** A human's note: steered into the running turn, else a turn of its own. */
  private note(msg: ChatMsg): void {
    const live = this.live;
    if (live !== null && this.mind.exhausted === null && this.mind.steer(`${this.noteBlock(msg)}\n(${msg.name} sent this while you were working: fold it in.)`)) {
      live.notes.push(msg);
      const at = this.anchor(msg);
      void this.actor.glide(at.x, at.y);
      return;
    }
    this.enqueue({ kind: "message", msg });
  }

  /** A human's message in comment thread `threadId`: a note pinned where the thread is, answered there. */
  private comment(threadId: string, m: ThreadMsg): void {
    if (m.kind !== "human" || this.closed) return;
    const t = this.actor.threads.get(threadId);
    const node = t?.get("node");
    const msg: ChatMsg = {
      id: m.id,
      kind: "human",
      name: m.name,
      color: m.color,
      text: m.text,
      nodeIds: typeof node === "string" && this.nodes.has(node) ? [node] : [],
      at: this.actor.pin(threadId),
      ts: m.ts,
      thread: threadId,
    };
    if (!this.hooks.direct(msg)) this.note(msg);
  }

  /** Presence changes stop once the session closed (its wrap-up runs without a cursor show). */
  private setP(patch: Partial<Presence>): void {
    if (!this.closed) this.actor.setP(patch);
  }

  private fadeBubble(): void {
    clearTimeout(this.clearBubbleTimer);
    this.clearBubbleTimer = setTimeout(() => {
      this.setP({ bubble: null, selected: [] });
    }, 8000);
  }

  /**
   * One line from the agent: in comment thread `thread` (when it still exists) as a reply there;
   * else spoken in the room (the bubble and the room chat), or held until someone has joined.
   */
  private speak(text: string, id: string, thread: string | null = null): void {
    const line = text.trim();
    if (line === "") return;
    if (thread !== null && postInThread(this.actor.threads, thread, this.actor.threadMessage(line))) {
      this.setP({ bubble: { text: line, replyTo: id, streaming: false, thread } });
      return;
    }
    if (!this.opened) {
      this.held.push(line);
      return;
    }
    const { user } = this.identity;
    this.setP({ bubble: { text: line, replyTo: id, streaming: false } });
    this.chat.push([{ id: `a-${id}`, kind: "agent", name: user.name, color: user.color, text: line, nodeIds: [], at: { ...this.actor.cursor }, ts: Date.now(), replyTo: id, model: this.modelKey() }]);
  }

  /** The opener's lines, said before anyone was here, now that someone is. */
  private async playHeld(): Promise<void> {
    if (this.options.typeMs !== 0) await sleep(OPEN_SETTLE_MS);
    this.opened = true;
    if (this.opener === "failed" && this.held.length === 0) {
      this.opener = "running";
      this.enqueue({ kind: "open" });
      return;
    }
    const lines = this.held;
    this.held = [];
    for (const [i, line] of lines.entries()) {
      if (this.closed) return;
      if (i > 0 && this.options.typeMs !== 0) await sleep(HELD_LINE_MS);
      this.speak(line, `open-${String(i)}`);
    }
    if (lines.length > 0 && this.live === null) this.fadeBubble();
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
        if (t.kind === "message") await this.respond(t.msg.id, this.prompt(t.msg), t.msg, "turn", t.msg.thread ?? null);
        else if (t.kind === "open") await this.open();
        else if (t.kind === "landed") await this.respond(`landed-${Date.now().toString(36)}`, this.landedPrompt(t.text, t.thread), null, "landed", t.thread);
        else t.done(await this.close());
      } catch (error) {
        this.hooks.log(`canvas agent ${this.identity.user.name}: ${error instanceof Error ? error.message : String(error)}`);
        this.setP({ status: "idle", doing: null, typing: null, connecting: null });
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
      const b = this.actor.box(id);
      if (b === null) continue;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
    }
    const x = Math.round(minX - 560);
    const lines = [
      this.prompt(null),
      "",
      "# Session start",
      `${this.identity.human} is joining the canvas from our chat. Open like the conversation is resuming mid-stream, not a greeting. Say, in plain words, where we left off in the chat on this board (what we were deciding or building, and where it stands), and that the open questions are going on the left. No "picking up" or "let's start" filler.`,
    ];
    const notes: string[] = [];
    if (missing.includes("agenda")) notes.push(`@add_node agenda note ${String(x)} ${String(Math.round(minY))} 480, title "Agenda", body 3 to 5 open questions for this session from the chat and the board, numbered "1 · "`);
    if (missing.includes("decisions")) notes.push(`@add_node decisions note ${String(x)} ${String(Math.round(minY + 560))} 480, title "Decisions", body "Nothing decided yet."`);
    if (notes.length > 0) lines.push(`Then, in one canvas_act batch: ${notes.join("; then ")}.`);
    lines.push('Finish with @point <the card the first open question is about> and ask that question in one line, e.g. "First one: is a third panel tool right, or should this live in the popover?" No other tools for the opener.');
    return lines.join("\n");
  }

  private async open(): Promise<void> {
    try {
      await this.respond(`open-${Date.now().toString(36)}`, this.openerPrompt(), null, "opener", null);
      this.opener = "done";
    } catch (error) {
      this.opener = "failed";
      throw error;
    }
  }

  private async close(): Promise<string> {
    if (this.summary !== null) return this.summary;
    this.closed = true;
    clearTimeout(this.endTimer);
    clearTimeout(this.lookTimer);
    // Isaac's notes and comments, and the lines of agents that joined to work the board, are what happened here.
    const comments = snapThreads(this.actor.threads).flatMap((t) => t.messages.filter((m) => m.kind === "human" && m.ts >= this.startedAt));
    const said = [...this.chat.toArray().filter((c) => c.kind === "human" || (c.kind === "agent" && c.name !== this.identity.user.name)), ...comments];
    let summary: string;
    if (said.length === 0) {
      summary = this.joined ? "Nothing was said at the canvas; the board is unchanged." : `${this.identity.human} did not join; the canvas session closed.`;
    } else if (this.mind.exhausted !== null) {
      summary = `The canvas session ended after ${String(said.length)} note${said.length === 1 ? "" : "s"}; ${this.mind.exhausted}, so no summary was written.`;
    } else {
      const prompt = [
        this.prompt(null),
        "",
        "# Session end",
        `The canvas session is ending. Write the note that goes back into our chat: 2 to 4 short plain sentences in your voice, what we worked on, what changed on the board (files you made, with paths), the decisions (from the Decisions note) and what is still open. Output plain text only: no tools, no @ lines.`,
      ].join("\n");
      this.actor.setP({ status: "thinking", bubble: null, doing: null, typing: null, connecting: null });
      let out = "";
      try {
        this.mind.setModel(this.modelKey());
        await this.mind.turn(prompt, {
          text: (d) => {
            out += d;
          },
          textEnd: () => {
            out += "\n";
          },
          tool: () => undefined,
          drafting: () => undefined,
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
    const { requests, tokens, costUsd } = this.mind.usage;
    if (requests > 0) this.hooks.log(`canvas agent ${user.name}: session used ${String(requests)} model requests, ${String(Math.round(tokens / 1000))}k tokens, $${costUsd.toFixed(2)}`);
    this.chat.push([{ id: `wrap-${Date.now().toString(36)}`, kind: "event", name: user.name, color: user.color, text: `Wrapped up: ${summary}`, nodeIds: [], at: null, ts: Date.now() }]);
    this.actor.setP({ status: "idle", bubble: null, doing: null, typing: null, connecting: null, selected: [] });
    this.summary = summary;
    this.mind.dispose();
    this.hooks.ended(summary);
    return summary;
  }

  private modelKey(): ModelKey {
    const model = this.doc.getMap(DOC_KEYS.settings).get("model");
    return typeof model === "string" && model in MODELS ? (model as ModelKey) : "opus";
  }

  /** Where the cursor goes when a note arrives: its pin, else the card it points at, else where it was sent. */
  private anchor(msg: ChatMsg | null): { x: number; y: number } {
    const pin = msg?.thread === undefined ? null : this.actor.pin(msg.thread);
    if (pin !== null) return { x: pin.x + 18, y: pin.y + 10 };
    const anchorId = msg?.nodeIds[0];
    const box = anchorId === undefined ? null : this.actor.box(anchorId);
    return box ? { x: box.x + box.w - 30, y: box.y + 26 } : msg?.at ? { x: msg.at.x + 70, y: msg.at.y + 50 } : this.actor.cursor;
  }

  /**
   * One turn of the mind: speech streams into the bubble (or, with `thread`, into that comment
   * thread), tools show as the status line, the cursor stays up.
   */
  private async respond(id: string, message: string, msg: ChatMsg | null, label: string, thread: string | null): Promise<void> {
    const t0 = performance.now();
    const modelKey = this.modelKey();
    const { user } = this.identity;
    if (this.mind.exhausted !== null) {
      // Out of budget: say so once per note and hand it to the chat instead.
      if (msg !== null) {
        this.speak(`I've used up this canvas session's budget, so I'm handing that to ${user.name} in the chat.`, `budget-${msg.id}`, thread);
        this.hooks.handoff("main", msg.text, msg);
        this.fadeBubble();
      }
      return;
    }
    clearTimeout(this.clearBubbleTimer);
    const live: Live = { id, notes: msg === null ? [] : [msg], said: [], thread, firstEdit: null };
    this.live = live;
    // React at once: think at the thing they pointed at, before the model answers.
    this.setP({ status: "thinking", replyTo: id, bubble: null, doing: null, typing: null, connecting: null, selected: [] });
    const target = this.anchor(msg);
    void this.actor.glide(target.x, target.y);
    const cursorMs = performance.now() - t0;
    const heartbeat = setInterval(() => {
      if (this.actor.presence.status === "idle") this.setP({ status: "thinking" });
    }, HEARTBEAT_MS);
    let firstToken = 0;
    let output = "";
    let segment = "";
    const flush = (): void => {
      const line = segment.trim();
      segment = "";
      if (line === "") return;
      live.said.push(line);
      this.speak(line, `${id}-${String(live.said.length)}`, thread);
    };
    try {
      this.mind.setModel(modelKey);
      await this.mind.turn(message, {
        text: (delta) => {
          if (firstToken === 0) firstToken = performance.now() - t0;
          output += delta;
          segment += delta;
          if (this.opened || thread !== null) this.setP({ bubble: { text: segment.trim(), replyTo: id, streaming: true, ...(thread === null ? {} : { thread }) }, doing: null });
        },
        textEnd: () => {
          output += "\n";
          flush();
        },
        tool: (name, intent) => {
          if (name !== "canvas_act" && name !== "canvas_read") this.setP({ status: "thinking", doing: statusLine(name, intent) });
        },
        drafting: (args) => {
          const line = draftLine(args);
          if (line !== null && line !== this.actor.presence.doing) this.setP({ status: "thinking", doing: line });
        },
      });
    } finally {
      clearInterval(heartbeat);
      if (segment.trim() !== "") flush();
      this.live = null;
      this.setP({ status: "idle", doing: null, typing: null, connecting: null });
      if (this.actor.presence.bubble?.streaming === true) this.setP({ bubble: { ...this.actor.presence.bubble, streaming: false } });
      this.fadeBubble();
    }
    const modelDone = performance.now() - t0;
    const firstEdit = live.firstEdit === null ? null : live.firstEdit - t0;
    const server: ServerMetrics = { model: modelKey, cursor: cursorMs, firstToken, firstEdit, modelDone, done: modelDone, output };
    this.doc.getMap(DOC_KEYS.metrics).set(`s:${id}`, server);
    const { requests, tokens, costUsd } = this.mind.usage;
    this.hooks.log(
      `canvas agent ${user.name} ${modelKey} ${label}: cursor=${cursorMs.toFixed(1)}ms first=${firstToken.toFixed(0)}ms edit=${firstEdit === null ? "-" : firstEdit.toFixed(0)}ms done=${modelDone.toFixed(0)}ms; room so far ${String(requests)} requests, ${String(Math.round(tokens / 1000))}k tokens, $${costUsd.toFixed(2)}`,
    );
    const reply = live.said.join(" ");
    for (const note of live.notes) this.hooks.turn({ name: note.name, text: note.text }, reply);
  }

  private landedPrompt(text: string, thread: string | null): string {
    return [
      this.prompt(null),
      "",
      "# Handoff landed",
      text,
      ...(thread === null ? [] : [`It was asked for in comment thread ${thread}: your text goes into that thread.`]),
      `Tell ${this.identity.human} it is done in one short line naming what landed, with a canvas_act @point <the new card> first when there is one. No other edits.`,
    ].join("\n");
  }

  /** A note (a comment in its thread, or a room note) with the card it is on, in full. */
  private noteBlock(msg: ChatMsg): string {
    const t = msg.thread === undefined ? undefined : this.actor.threads.get(msg.thread);
    const thread = msg.thread === undefined || t === undefined ? null : snapThread(msg.thread, t);
    const lines = [thread === null ? "# The note" : `# The comment (thread ${thread.id})`];
    if (thread !== null) {
      const pin = this.actor.pin(thread.id);
      const where = pin === null ? "" : ` @${String(Math.round(pin.x))},${String(Math.round(pin.y))}`;
      lines.push(thread.anchor.node !== undefined ? `Pinned on card [${thread.anchor.node}]${where}.` : `Pinned on the board${where}, on no card.`);
    } else lines.push(msg.nodeIds.length > 0 ? `Attached cards (selected when sent): ${msg.nodeIds.join(", ")}` : "No card attached.");
    for (const id of msg.nodeIds) {
      const m = this.nodes.get(id);
      if (m !== undefined) lines.push(`[${id}] ${str(m, "type")}: ${str(m, "title")}${str(m, "body") === "" ? "" : `\n${str(m, "body")}`}`);
    }
    if (thread === null && msg.at) lines.push(`Sent at cursor @${String(Math.round(msg.at.x))},${String(Math.round(msg.at.y))}.`);
    const before = thread?.messages.filter((m) => m.id !== msg.id) ?? [];
    if (before.length > 0) lines.push("The thread so far:", ...before.map((m) => `${m.name}: ${m.text}`));
    lines.push(`${msg.name} says: ${msg.text}`);
    if (thread !== null && thread.id !== this.live?.thread && this.live !== null) lines.push(`Answer this one in its thread: @reply ${thread.id} <line>.`);
    return lines.join("\n");
  }

  /** Per-turn context: purpose, the board (long bodies clipped), who is here and their selections, recent chat, the note. */
  private prompt(msg: ChatMsg | null): string {
    const lines: string[] = [];
    const title = str(this.doc.getMap(DOC_KEYS.meta), "title") || "Board";
    lines.push("# Board", `Title: ${title} (board ${this.identity.slug})`);
    if (this.identity.purpose !== "") lines.push(`Session goal: ${this.identity.purpose}`);
    const selected = new Set<string>(msg?.nodeIds ?? []);
    for (const [, p] of this.humans()) for (const id of p.selected ?? []) selected.add(id);
    lines.push("Coordinates in px, x grows right, y grows down. Each card: [id] type @x,y w×h, then title and body (clipped: canvas_read has it whole).");
    for (const [id, m] of this.nodes) {
      const b = this.actor.box(id);
      if (!b) continue;
      const type = str(m, "type");
      const parent = m.get("parent");
      lines.push(`[${id}] ${type} @${String(Math.round(b.x))},${String(Math.round(b.y))} ${String(Math.round(b.w))}×${String(Math.round(b.h))}${typeof parent === "string" ? ` in frame ${parent}` : ""}`, `title: ${str(m, "title")}`);
      if (type === "image") lines.push(`image: ${str(m, "src")} (caption: ${str(m, "caption")})`);
      if (type === "proto") lines.push(`prototype in ${str(m, "system") || "relay"}${str(m, "viewport") === "mobile" ? ", mobile" : ""}`);
      for (const k of ["key", "status", "pr", "url"]) if (str(m, k) !== "") lines.push(`${k}: ${str(m, k)}`);
      const body = str(m, "body");
      if (body !== "") {
        const whole = selected.has(id) || id === "agenda" || id === "decisions" || body.length <= BODY_CLIP;
        lines.push(`body:\n${whole ? body : `${body.slice(0, BODY_CLIP)}… (${String(body.length)} chars)`}`);
      }
      lines.push("");
    }
    lines.push("# Edges");
    for (const [, e] of this.edges) {
      const label = e.get("label");
      lines.push(`${String(e.get("source"))} -> ${String(e.get("target"))}${typeof label === "string" && label !== "" ? ` "${label}"` : ""}`);
    }

    lines.push("", "# People here now");
    for (const [, p] of this.humans()) {
      const sel = p.selected?.length ? `selected: ${p.selected.join(", ")}` : "nothing selected";
      const at = p.cursor ? `, cursor @${String(Math.round(p.cursor.x))},${String(Math.round(p.cursor.y))}` : "";
      lines.push(`- ${p.user.name}: ${sel}${at}`);
    }
    const workers = this.hooks.workers();
    if (workers.length > 1) lines.push("", "# Workers in the room (a request in their lane can go to them with @handoff <Name> <request>)", ...workers.slice(1));

    const recent = this.chat
      .toArray()
      .filter((c) => c.id !== msg?.id && c.kind !== "event")
      .slice(-12);
    lines.push("", "# Recent room chat (oldest first)");
    if (recent.length === 0) lines.push("(none yet)");
    for (const c of recent) lines.push(`${c.name}${c.nodeIds.length > 0 ? ` [on ${c.nodeIds.join(", ")}]` : ""}: ${c.text}`);

    const { open, resolved } = orderThreads(snapThreads(this.actor.threads));
    const others = open.filter((t) => t.id !== msg?.thread).slice(0, 12);
    lines.push("", `# Open comment threads (newest first; ${String(resolved.length)} resolved not shown)`);
    if (others.length === 0) lines.push("(none)");
    for (const t of others) {
      const on = t.anchor.node !== undefined ? `on [${t.anchor.node}]` : `at @${String(Math.round(t.anchor.x))},${String(Math.round(t.anchor.y))}`;
      lines.push(`[${t.id}] ${on}: ${t.messages.slice(-3).map((m) => `${m.name}: ${excerpt(m.text, 160)}`).join(" / ")}`);
    }

    if (msg) lines.push("", this.noteBlock(msg));
    return lines.join("\n");
  }
}
