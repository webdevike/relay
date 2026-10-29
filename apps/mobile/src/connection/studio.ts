/**
 * Routes Studio's server frames into the studio store (`studio.state` replaces everything,
 * `studio.job` and `studio.removed` patch it) and `studio.res` to the `studio.req` waiting on its rid.
 */
import type { ServerMessage, StudioResult } from "@relay/protocol";
import type { StudioStore } from "@/state/studio";

export type StudioFrameRouter = (message: ServerMessage) => void;

/** How long a Studio request waits for the host's answer before it counts as failed. */
export const STUDIO_TIMEOUT_MS = 30_000;

/** `studio.req` requests sent and not yet answered, by rid. */
export class PendingStudio {
  private readonly waiting = new Map<string, { resolve: (result: StudioResult) => void; timer: number }>();

  constructor(private readonly timeoutMs = STUDIO_TIMEOUT_MS) {}

  /** Resolves with the host's answer to `rid`, or a failure after the timeout or `cancelAll`. */
  add(rid: string): Promise<StudioResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle({ rid, ok: false, error: "Your Mac did not answer." });
      }, this.timeoutMs);
      this.waiting.set(rid, { resolve, timer });
    });
  }

  settle(result: StudioResult): void {
    const entry = this.waiting.get(result.rid);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.waiting.delete(result.rid);
    entry.resolve(result);
  }

  /** The connection went to another host: nothing still waiting will be answered. */
  cancelAll(): void {
    for (const rid of [...this.waiting.keys()]) this.settle({ rid, ok: false, error: "Disconnected." });
  }
}

export function createStudioFrameRouter(store: Pick<StudioStore, "setState" | "upsertJob" | "remove" | "addUpload">, pending: PendingStudio): StudioFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "studio.state") store.setState({ jobs: message.jobs, uploads: message.uploads, backends: message.backends });
    if (message.t === "studio.job") store.upsertJob(message.job);
    if (message.t === "studio.removed") store.remove(message.id);
    if (message.t === "studio.res") {
      // A created job and a new upload show at once; the host's own frames confirm them.
      if (message.ok && message.job !== undefined) store.upsertJob(message.job);
      if (message.ok && message.asset?.origin === "upload") store.addUpload(message.asset);
      pending.settle(message);
    }
  };
}
