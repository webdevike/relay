// The activity list: one place where the host gathers what agents are running (helpers from the
// artifacts, sessions from the omp bridge, harnesses from `herdr agent list`, canvas rooms), merges
// it with what it said before (`mergeActivity`) and pushes `activity.snapshot` to every device
// when it changes. Every client draws this list, so the Mini and the MacBook always agree.
import { mergeActivity, type ActivityItem, type ActivityKind, type AgentSession, type Artifact, type CanvasRoomInfo, type ServerMessage } from "@relay/protocol";
import type { HerdrAgent } from "../agents/herdr";
import type { AgentProviderChange } from "../seams";
import type { SessionClock } from "../session";
import { canvasItems, harnessItems, helperItems, sessionItems } from "./sources";

/** Changes arriving together are read once. */
export const ACTIVITY_SETTLE_MS = 250;
/** herdr and the transcripts on disk have no events: they are looked at this often. */
export const ACTIVITY_POLL_MS = 10_000;

export interface ActivityServiceDeps {
  readonly sessions: () => readonly AgentSession[];
  /** What a session blocked on Isaac asks him (its pending ask or approval); null when there is none. */
  readonly question: (sessionId: string) => string | null;
  readonly helpers: () => { thread: string; item: Artifact }[];
  /** `herdr agent list`; rejects when herdr is missing or down. */
  readonly harnesses: () => Promise<HerdrAgent[]>;
  readonly rooms: () => CanvasRoomInfo[];
  /** What a live room's agent has spent, in dollars. */
  readonly roomCost: (slug: string) => number | undefined;
  readonly broadcast: (message: ServerMessage) => void;
  readonly clock: SessionClock;
  readonly log: (line: string) => void;
}

/** What a client session and the server need of the activity list. */
export interface ActivityRelaying {
  /** Pushes the current list to every device. */
  get(): void;
  /** Something a source reports may have changed: read it soon. */
  poke(): void;
  observe(change: AgentProviderChange): void;
}

export class ActivityService implements ActivityRelaying {
  private items: ActivityItem[] = [];
  private pushed = "";
  private settle: (() => void) | null = null;
  private tick: (() => void) | null = null;
  private reading = false;
  private again = false;
  private harnesses: HerdrAgent[] | null = null;
  private harnessesAt = 0;

  constructor(private readonly deps: ActivityServiceDeps) {}

  /** Starts the poll that notices what has no event: harness panes and helper transcripts. */
  start(): void {
    if (this.tick !== null) return;
    const loop = (): void => {
      this.tick = this.deps.clock.after(ACTIVITY_POLL_MS, () => {
        this.tick = null;
        this.poke();
        loop();
      });
    };
    loop();
    this.poke();
  }

  stop(): void {
    this.tick?.();
    this.tick = null;
    this.settle?.();
    this.settle = null;
  }

  get(): void {
    void this.read(true);
  }

  poke(): void {
    if (this.settle !== null) return;
    this.settle = this.deps.clock.after(ACTIVITY_SETTLE_MS, () => {
      this.settle = null;
      void this.read(false);
    });
  }

  observe(change: AgentProviderChange): void {
    if (change.kind === "sessions" || change.kind === "ask" || change.kind === "ask.resolved" || change.kind === "approval" || change.kind === "approval.resolved") this.poke();
  }

  /** The list as last built (tests, and a device that joins). */
  snapshot(): readonly ActivityItem[] {
    return this.items;
  }

  private async read(force: boolean): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      const now = this.deps.clock.now();
      const answered = new Set<ActivityKind>(["helper", "session", "canvas"]);
      if (this.harnesses === null || now - this.harnessesAt >= ACTIVITY_POLL_MS / 2) {
        try {
          this.harnesses = await this.deps.harnesses();
          this.harnessesAt = this.deps.clock.now();
        } catch (error) {
          this.harnesses = null;
          this.deps.log(`activity: herdr agent list failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (this.harnesses !== null) answered.add("harness");
      const at = this.deps.clock.now();
      const found = [
        ...helperItems(this.deps.helpers(), at),
        ...sessionItems(this.deps.sessions(), this.deps.question),
        ...harnessItems(this.harnesses ?? [], at),
        ...canvasItems(this.deps.rooms(), this.deps.roomCost),
      ];
      this.items = mergeActivity(this.items, found, answered, at);
      const key = JSON.stringify(this.items);
      if (force || key !== this.pushed) {
        this.pushed = key;
        this.deps.broadcast({ t: "activity.snapshot", items: this.items });
      }
    } finally {
      this.reading = false;
      if (this.again) {
        this.again = false;
        this.poke();
      }
    }
  }
}
