// Trial mode on the host (@relay/protocol TRIALS_FEATURE): every device draws the trial cards and the agents'
// switch messages from `trials.snapshot`, folded from the atomic-agents journal (trials/book.ts) by the same
// `SpecialistRunBook` read the threads' badges use, and pushed to every device when one moves. Isaac's pick
// and Undo are journal lines the host appends (`<agent>/trial.picked`, `<agent>/trial.undone` plus the
// `atomic-agents/config.set` that puts the old model back); the service keeps the tally and applies the patch.

import {
  canPickTrial,
  type ServerMessage,
  type TrialPick,
  type TrialsSnapshot,
  type WidgetSurface,
} from "@relay/protocol";
import type { SpecialistRunBook } from "../assistant/specialist-runs";
import { emit } from "../widgets/bus";
import { trialsSignature } from "./book";

/** An answer to a pick or an undo: `error` says why it was not recorded. */
export interface TrialAnswer {
  readonly ok: boolean;
  readonly error?: string;
}

/** What a device session needs of trial mode. */
export interface TrialRelaying {
  /** Every card and switch message as the journal has them now. */
  snapshot(): Promise<TrialsSnapshot>;
  /** Records Isaac's pick on card `trial`; every device gets the revealed card. */
  pick(trial: string, pick: TrialPick, surface: WidgetSurface): Promise<TrialAnswer>;
  /** Takes back switch `switchId`: the old model and the trial come back. */
  undo(switchId: string): Promise<TrialAnswer>;
}

export interface TrialServiceDeps {
  /** The atomic-agents home: its journal is where picks and undos go. */
  readonly home: string;
  /** The journal read the threads share; its `trials()` is the fold of its last read. */
  readonly book: SpecialistRunBook;
  /** Sends `message` to every authenticated device. */
  readonly broadcast: (message: ServerMessage) => void;
  readonly log: (line: string) => void;
}

export class TrialService implements TrialRelaying {
  /** The last snapshot pushed, as `trialsSignature`; null before the first. */
  private signature: string | null = null;
  /** Picks and undos one at a time, each checked against the journal the one before it wrote. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stop: () => void;

  constructor(private readonly deps: TrialServiceDeps) {
    this.stop = deps.book.onChange(() => {
      void this.publish();
    });
  }

  async snapshot(): Promise<TrialsSnapshot> {
    await this.deps.book.current();
    return this.deps.book.trials().snapshot;
  }

  pick(trialId: string, pick: TrialPick, surface: WidgetSurface): Promise<TrialAnswer> {
    return this.serial(async () => {
      await this.deps.book.current();
      const trial = this.deps.book.trials().snapshot.trials.find((t) => t.id === trialId);
      if (trial === undefined) return { ok: false, error: "There is no such trial" };
      if (trial.pick !== undefined) return { ok: false, error: "This trial was already picked" };
      if (!canPickTrial(trial, pick)) return { ok: false, error: "That result has not finished" };
      try {
        emit(
          this.deps.home,
          trial.agent,
          "trial.picked",
          { trialId, pick, surface, by: "isaac" },
          "trial",
          "pick",
        );
      } catch (error) {
        return this.failed(`cannot save the pick on ${trialId}`, error);
      }
      this.deps.log(`trials: ${trial.agent} ${trialId} picked ${pick} on the ${surface}`);
      await this.changed();
      return { ok: true };
    });
  }

  undo(switchId: string): Promise<TrialAnswer> {
    return this.serial(async () => {
      await this.deps.book.current();
      const taken = this.deps.book.trials().undo.get(switchId);
      if (taken === undefined) return { ok: false, error: "There is no such switch" };
      if (taken.undone) return { ok: false, error: "This switch was already undone" };
      if (typeof taken.patch !== "object" || taken.patch === null)
        return { ok: false, error: "This switch has nothing to undo" };
      try {
        emit(this.deps.home, taken.agent, "trial.undone", { switchId }, "trial", "undo");
        emit(
          this.deps.home,
          "atomic-agents",
          "config.set",
          { by: "isaac", patch: taken.patch },
          "config",
          "undo",
        );
      } catch (error) {
        return this.failed(`cannot undo ${switchId}`, error);
      }
      this.deps.log(`trials: ${taken.agent} switch ${switchId} undone`);
      await this.changed();
      return { ok: true };
    });
  }

  /** Stops following the journal. */
  close(): void {
    this.stop();
  }

  private failed(what: string, error: unknown): TrialAnswer {
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log(`trials: ${what}: ${message}`);
    return { ok: false, error: message };
  }

  /** After the host's own write: every device gets the new snapshot now, and the threads redraw their badges. */
  private async changed(): Promise<void> {
    await this.publish();
    await this.deps.book.notify();
  }

  /** Pushes the snapshot to every device when it moved since the last push. */
  private async publish(): Promise<void> {
    if ((await this.deps.book.current()) === null) return;
    const fold = this.deps.book.trials();
    const signature = trialsSignature(fold);
    if (signature === this.signature) return;
    this.signature = signature;
    this.deps.broadcast({ t: "trials.snapshot", ...fold.snapshot });
  }

  private serial(work: () => Promise<TrialAnswer>): Promise<TrialAnswer> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
