/**
 * Routes `artifacts.snapshot` into the artifacts store (the answer to `artifacts.get`, and the
 * host's push after every change) and `artifacts.acted` to the `artifacts.act` waiting on its rid.
 */
import type { ServerMessage } from "@relay/protocol";
import type { ArtifactsStore } from "@/state/artifacts";

export type ArtifactFrameRouter = (message: ServerMessage) => void;

export interface ActResult {
  ok: boolean;
  error?: string | undefined;
  id?: string | undefined;
}

/** How long an act waits for the host's answer before it counts as failed. */
export const ACT_TIMEOUT_MS = 10_000;

/** `artifacts.act` requests sent and not yet answered, by rid. */
export class PendingActs {
  private readonly waiting = new Map<string, { resolve: (result: ActResult) => void; timer: number }>();

  /** Resolves with the host's answer to `rid`, or a failure after `ACT_TIMEOUT_MS` or `cancelAll`. */
  add(rid: string): Promise<ActResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(rid, { ok: false, error: "Your Mac did not answer." });
      }, ACT_TIMEOUT_MS);
      this.waiting.set(rid, { resolve, timer });
    });
  }

  settle(rid: string, result: ActResult): void {
    const entry = this.waiting.get(rid);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.waiting.delete(rid);
    entry.resolve(result);
  }

  /** The connection went to another host: nothing still waiting will be answered. */
  cancelAll(): void {
    for (const rid of [...this.waiting.keys()]) this.settle(rid, { ok: false, error: "Disconnected." });
  }
}

export function createArtifactFrameRouter(store: Pick<ArtifactsStore, "set">, pending: PendingActs): ArtifactFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "artifacts.snapshot") store.set(message.thread, { items: message.items, tabs: message.tabs });
    if (message.t === "artifacts.acted") pending.settle(message.rid, { ok: message.ok, error: message.error, id: message.id });
  };
}
