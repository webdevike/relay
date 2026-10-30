// An agent that joined a live room on its own (`relay-linux canvas join <slug> --as <Name>`): any
// omp session, a subagent included, next to the room's canvas self. Like a Rooms seat it is a
// person in the room: its own name, color and portrait, its own cursor (its own awareness client,
// bridged into the room's awareness), and its edits and lines attributed to it. It acts in batches
// of the canvas self's action lines (dsl.ts), run one after another through its own CanvasActor,
// so five joined agents work the board at once without thrashing it: each one's actions are
// serialized and paced, a participant may have only a few batches waiting, and a room takes
// only so many participants. Its `@say` lines go into the room's cursor chat as agent lines; they
// never start a turn of the canvas self, which only answers humans.

import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { DOC_KEYS, type ChatMsg, type User } from "@relay/canvas-live/shared";
import { CanvasActor, sleep, type ActorOptions } from "./actor";
import { type Action, ActionParser } from "./dsl";

/** The most agents that may join one room (a Rooms room seats up to 8 too). */
export const MAX_PARTICIPANTS = 8;
/** Batches one participant may have waiting behind the one running; more is refused (429). */
export const MAX_QUEUED_BATCHES = 3;
/** Actions in one batch. */
export const MAX_BATCH_ACTIONS = 40;
/** Pause between a participant's actions, so each lands visibly before the next. */
export const PACE_MS = 150;
/** A participant that acted this long ago leaves by itself (its cursor would otherwise linger). */
export const IDLE_LEAVE_MS = 15 * 60_000;

export interface ParticipantOptions extends ActorOptions {
  readonly paceMs?: number;
  readonly idleLeaveMs?: number;
}

/** What one batch did. */
export interface ActResult {
  /** Actions that ran. */
  readonly ran: number;
  /** Lines it said, in order. */
  readonly said: string[];
  /** Actions that did not run, with why (`add_edge a b: no node b`). */
  readonly skipped: string[];
}

/** A batch the participant refused before running any of it. */
export class ActRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Step = { kind: "say"; text: string } | { kind: "action"; action: Action };

/** The batch's steps in script order; `@say` lines and actions interleave as written. */
function parseScript(script: string): Step[] {
  const steps: Step[] = [];
  const parser = new ActionParser(
    (action) => {
      steps.push({ kind: "action", action });
    },
    (chunk) => {
      const last = steps.at(-1);
      if (chunk === "\n") {
        steps.push({ kind: "say", text: "" });
        return;
      }
      if (last?.kind === "say") last.text += chunk;
      else steps.push({ kind: "say", text: chunk });
    },
  );
  parser.feed(script.endsWith("\n") ? script : `${script}\n`);
  parser.finish();
  return steps.filter((step) => step.kind === "action" || step.text.trim() !== "");
}

const describe = (a: Action): string => (a.kind === "add_edge" ? `add_edge ${a.source} ${a.target}` : a.kind === "cursor" ? `cursor ${String(a.x)} ${String(a.y)}` : `${a.kind} ${a.id}`);

export class CanvasParticipant {
  /** The participant's own awareness client: its cursor is a separate person in the room. */
  private readonly own: awarenessProtocol.Awareness;
  private readonly actor: CanvasActor;
  private readonly chat: Y.Array<ChatMsg>;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private left = false;
  private bubbleTimer: Timer | undefined;
  private idleTimer: Timer | undefined;
  private said = 0;
  private readonly forward = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }): void => {
    const update = awarenessProtocol.encodeAwarenessUpdate(this.own, [...added, ...updated, ...removed]);
    awarenessProtocol.applyAwarenessUpdate(this.roomAwareness, update, this);
  };

  constructor(
    readonly id: string,
    readonly user: User,
    /** What it is here to do, from `canvas join --prompt`; empty when not given. */
    readonly purpose: string,
    private readonly doc: Y.Doc,
    private readonly roomAwareness: awarenessProtocol.Awareness,
    private readonly options: ParticipantOptions,
    start: { x: number; y: number },
    /** Called once when it leaves (by itself after `idleLeaveMs`, or `leave()`). */
    private readonly onLeft: (participant: CanvasParticipant) => void,
  ) {
    this.own = new awarenessProtocol.Awareness(new Y.Doc());
    this.own.on("update", this.forward);
    this.chat = doc.getArray(DOC_KEYS.chat);
    this.actor = new CanvasActor(doc, this.own, user, `participant:${id}`, options, start);
    this.event(`${user.name} joined${purpose === "" ? "" : `: ${purpose}`}`);
    this.touch();
  }

  /** The awareness client id its cursor has in the room. */
  get clientId(): number {
    return this.own.clientID;
  }

  /**
   * Queues one batch of action lines and resolves when it has run. Refuses (`ActRefused`) a batch
   * that is too long, one with nothing to do, or one more than `MAX_QUEUED_BATCHES` behind.
   */
  act(script: string): Promise<ActResult> {
    if (this.left) return Promise.reject(new ActRefused(410, `${this.user.name} has left the room; join again.`));
    const steps = parseScript(script);
    const actions = steps.filter((step) => step.kind === "action").length;
    if (steps.length === 0) return Promise.reject(new ActRefused(400, "nothing to do: no @say or action lines"));
    if (actions > MAX_BATCH_ACTIONS) return Promise.reject(new ActRefused(400, `${String(actions)} actions in one batch; send at most ${String(MAX_BATCH_ACTIONS)}`));
    if (this.pending > MAX_QUEUED_BATCHES) return Promise.reject(new ActRefused(429, `${this.user.name} already has ${String(this.pending)} batches waiting; wait for them to finish`));
    this.pending += 1;
    this.touch();
    const run = this.chain.then(() => this.run(steps));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.pending -= 1;
      this.touch();
    });
  }

  /** Leaves the room: its cursor goes, a "left" line goes into the chat (unless the room is closing). */
  leave(silent = false): void {
    if (this.left) return;
    this.left = true;
    clearTimeout(this.bubbleTimer);
    clearTimeout(this.idleTimer);
    if (!silent) this.event(`${this.user.name} left`);
    this.actor.dispose();
    // A null state is the awareness protocol's "gone": the room drops the cursor at once.
    this.own.setLocalState(null);
    this.own.off("update", this.forward);
    this.own.destroy();
    this.onLeft(this);
  }

  private async run(steps: Step[]): Promise<ActResult> {
    const said: string[] = [];
    const skipped: string[] = [];
    let ran = 0;
    clearTimeout(this.bubbleTimer);
    for (const step of steps) {
      if (this.left) {
        if (step.kind === "action") skipped.push(`${describe(step.action)}: left the room`);
        continue;
      }
      if (step.kind === "say") {
        const text = step.text.trim();
        said.push(text);
        this.say(text);
        continue;
      }
      const why = await this.actor.run(step.action);
      if (why === null) ran += 1;
      else skipped.push(`${describe(step.action)}: ${why}`);
      await sleep(this.options.paceMs ?? PACE_MS);
    }
    if (!this.left) {
      this.actor.setP({ status: "idle", typing: null, connecting: null });
      this.bubbleTimer = setTimeout(() => {
        if (!this.left) this.actor.setP({ bubble: null, selected: [] });
      }, 8000);
    }
    return { ran, said, skipped };
  }

  private say(text: string): void {
    const { user } = this;
    this.said += 1;
    const id = `${this.id}-${String(this.said)}`;
    this.actor.setP({ bubble: { text, replyTo: id, streaming: false } });
    this.doc.transact(() => {
      this.chat.push([{ id, kind: "agent", name: user.name, color: user.color, text, nodeIds: [], at: { ...this.actor.cursor }, ts: Date.now() }]);
    }, this.actor.origin);
  }

  private event(text: string): void {
    const { user } = this;
    this.doc.transact(() => {
      this.chat.push([{ id: `${this.id}-ev-${Date.now().toString(36)}`, kind: "event", name: user.name, color: user.color, text, nodeIds: [], at: null, ts: Date.now() }]);
    }, `participant:${this.id}`);
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    if (this.left) return;
    this.idleTimer = setTimeout(() => {
      if (this.pending === 0) this.leave();
      else this.touch();
    }, this.options.idleLeaveMs ?? IDLE_LEAVE_MS);
  }
}
