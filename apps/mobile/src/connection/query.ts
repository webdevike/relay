/**
 * Live widgets' data on the phone (dashboard tiles): one `query.req` per Query fetch, answered by
 * `query.res` on its rid. Only sent to a host whose `welcome.features` has "query"; an older host
 * drops the connection on a frame it doesn't know, so without the feature nothing is sent and the
 * tile draws the static spec the host rendered at write time.
 */
import { QUERY_FEATURE, type OpenUIQueryClient, type ServerMessage } from "@relay/protocol";

/** How long a query waits for the host's answer before the widget keeps its last data. */
export const QUERY_TIMEOUT_MS = 20_000;

type Answer = { ok: true; data: unknown } | { ok: false; error: string };

/** `query.req` requests sent and not yet answered, by rid. */
export class PendingQueries {
  private readonly waiting = new Map<string, { resolve: (answer: Answer) => void; timer: number }>();

  constructor(private readonly timeoutMs = QUERY_TIMEOUT_MS) {}

  /** Resolves with the host's answer to `rid`, or a failure after the timeout or `cancelAll`. */
  add(rid: string): Promise<Answer> {
    // Executor form: the phone's test runtime predates Promise.withResolvers.
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(rid, { ok: false, error: "Your Mac did not answer." });
      }, this.timeoutMs);
      this.waiting.set(rid, { resolve, timer });
    });
  }

  settle(rid: string, answer: Answer): void {
    const entry = this.waiting.get(rid);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.waiting.delete(rid);
    entry.resolve(answer);
  }

  /** The connection went away: nothing still waiting will be answered. */
  cancelAll(): void {
    for (const rid of [...this.waiting.keys()]) this.settle(rid, { ok: false, error: "Disconnected." });
  }
}

/** Keeps whether the host answers queries (from each `welcome`) and settles `query.res`. */
export function createQueryFrameRouter(setQueries: (on: boolean) => void, pending: PendingQueries): (message: ServerMessage) => void {
  return (message) => {
    if (message.t === "welcome") setQueries(message.features?.includes(QUERY_FEATURE) === true);
    if (message.t === "query.res") pending.settle(message.rid, message.ok ? { ok: true, data: message.data } : { ok: false, error: message.error ?? "The query failed." });
  };
}

/**
 * The query client live tiles share: `send` puts a `query.req` on the socket (false while not
 * connected), the answer comes back through `pending`.
 */
export function createQueryClient(pending: PendingQueries, send: (rid: string, tool: string, args: Record<string, unknown>) => boolean): OpenUIQueryClient {
  return {
    async run(tool, args) {
      const rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const answer = pending.add(rid);
      if (!send(rid, tool, args)) pending.settle(rid, { ok: false, error: "Not connected to your Mac." });
      const result = await answer;
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
  };
}
