// One door to the query tools for every client (the `query.req` frame, loopback `POST /query`, the
// canvas page's `POST /canvas/<slug>/query`): args checked against the tool's strict schema, a
// per-caller rate limit, a cache per tool + args (fresh for the tool's `ttlMs`, so ten widgets
// polling the same query cost one read), one read in flight per key, at most a few sources running
// at once, and the result parsed through the tool's result schema and capped in size.

import { checkQueryArgs, QUERY_TOOLS, type QueryAnswer, type QueryToolName } from "@relay/protocol";
import type { QueryTools } from "./tools";

/** Requests one caller may make per window before `rate limited`. */
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
/** Sources reading at once; the rest wait their turn. */
const MAX_RUNNING = 4;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_CACHED = 200;

export interface QueryRelaying {
  /** Runs `tool` for `caller` (a device id, `loopback`, `canvas:<slug>`); never rejects. */
  run(tool: string, args: unknown, caller: string): Promise<QueryAnswer>;
}

interface Cached {
  at: number;
  data: unknown;
}

export class QueryService implements QueryRelaying {
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly calls = new Map<string, number[]>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly tools: QueryTools,
    private readonly now: () => number,
    private readonly log: (line: string) => void,
  ) {}

  async run(tool: string, args: unknown, caller: string): Promise<QueryAnswer> {
    const checked = checkQueryArgs(tool, args);
    if (!checked.ok) return { ok: false, error: checked.error };
    if (!this.admit(caller)) return { ok: false, error: `rate limited: at most ${String(RATE_LIMIT)} queries a minute` };
    const key = `${checked.tool}:${stableJson(checked.args)}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < QUERY_TOOLS[checked.tool].ttlMs) return { ok: true, data: cached.data };
    try {
      let pending = this.inFlight.get(key);
      if (!pending) {
        pending = this.read(checked.tool, checked.args, key).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, pending);
      }
      return { ok: true, data: await pending };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`query ${checked.tool} failed: ${message}`);
      return { ok: false, error: message.slice(0, 300) };
    }
  }

  private async read(tool: QueryToolName, args: Record<string, unknown>, key: string): Promise<unknown> {
    await this.slot();
    try {
      // The args were parsed by this tool's own schema in `run`.
      const raw = await (this.tools[tool] as (a: Record<string, unknown>) => Promise<unknown>)(args);
      const parsed = QUERY_TOOLS[tool].result.safeParse(raw);
      if (!parsed.success) throw new Error(`${tool} returned an unexpected shape`);
      if (JSON.stringify(parsed.data).length > MAX_RESULT_BYTES) throw new Error(`${tool} result is over ${String(MAX_RESULT_BYTES / 1024)} KB; ask for fewer rows`);
      this.cache.delete(key);
      this.cache.set(key, { at: this.now(), data: parsed.data });
      if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value ?? "");
      return parsed.data;
    } finally {
      this.release();
    }
  }

  /** Sliding window per caller. */
  private admit(caller: string): boolean {
    const now = this.now();
    const recent = (this.calls.get(caller) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      this.calls.set(caller, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(caller, recent);
    return true;
  }

  private slot(): Promise<void> {
    if (this.running < MAX_RUNNING) {
      this.running++;
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.waiting.push(() => {
      this.running++;
      resolve(undefined);
    });
    return promise;
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }
}

/** JSON with object keys sorted, so equal args share a cache key. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
