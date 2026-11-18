// The host's side of the atomic-agents bus (packages/atomic-agents, its own install and service,
// `ai.eva.atomic-agents`). The bus is one append-only journal, `<home>/events.ndjson`, one JSON event
// per line (`{id, type: "<component>/<name>", component, job, run, at, data}`); every process appends
// and tails it. The host only appends and reads lines: no Effect, no import of the package. A
// request/response is the package's `Ask.ts` contract: append the request with a fresh `requestId`,
// then read what follows the old end of the journal until the reply with that id, or time out.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** `ATOMIC_AGENTS_HOME`, else `$XDG_CONFIG_HOME/relay/atomic-agents`: where the service keeps its journal and config. */
export function defaultAtomicAgentsHome(): string {
  const set = process.env["ATOMIC_AGENTS_HOME"];
  if (set !== undefined && set !== "") return set;
  return join(
    process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
    "relay",
    "atomic-agents",
  );
}

export interface AgentEvent {
  readonly id: string;
  readonly type: string;
  readonly component: string;
  readonly job: string;
  readonly run: string;
  readonly at: string;
  readonly data: unknown;
}

/** One journal line for `component/name`, written by the host; its run is `<runPrefix>-<8 hex>`. */
function event(
  component: string,
  name: string,
  job: string,
  data: unknown,
  runPrefix: string,
): AgentEvent {
  const id = randomUUID();
  return {
    id,
    type: `${component}/${name}`,
    component,
    job,
    run: `${runPrefix}-${id.slice(0, 8)}`,
    at: new Date().toISOString(),
    data,
  };
}

/** Appends one event line; one `write` per line, as the package's own bus does. */
export function emit(
  home: string,
  component: string,
  name: string,
  data: unknown,
  job = "relay",
  runPrefix = "relay",
): void {
  const journal = join(home, "events.ndjson");
  mkdirSync(dirname(journal), { recursive: true });
  appendFileSync(journal, `${JSON.stringify(event(component, name, job, data, runPrefix))}\n`);
}

/** What a consumer did with an agent's answer (the package's `atomic-agents/outcome.reported`, `Outcome`). */
export type Outcome = "used" | "skipped" | "none" | "timeout";

export interface OutcomeReport {
  /** The id `ask` sent: the run carries it, so the service records the outcome on that run's trace. */
  readonly requestId: string;
  /** Who used it, e.g. `relay.widgets`. */
  readonly consumer: string;
  readonly outcome: Outcome;
  readonly latencyMs: number;
  readonly detail?: string;
}

/** Appends `atomic-agents/outcome.reported`: any consumer of any agent reports this way. */
export function reportOutcome(home: string, report: OutcomeReport): void {
  emit(home, "atomic-agents", "outcome.reported", report, "outcome", "relay");
}

async function size(journal: string): Promise<number> {
  try {
    return (await stat(journal)).size;
  } catch {
    return 0;
  }
}

/** The complete lines appended after byte `from` (a writer may be mid-line), and where the next read starts. */
async function readFrom(journal: string, from: number): Promise<{ lines: string[]; next: number }> {
  const end = await size(journal);
  if (end <= from) return { lines: [], next: end < from ? 0 : from };
  const file = await open(journal, "r");
  try {
    const buffer = Buffer.alloc(end - from);
    await file.read(buffer, 0, buffer.length, from);
    const last = buffer.lastIndexOf(0x0a);
    if (last < 0) return { lines: [], next: from };
    return { lines: buffer.subarray(0, last).toString("utf8").split("\n"), next: from + last + 1 };
  } finally {
    await file.close();
  }
}

export interface AskOptions {
  readonly timeoutMs: number;
  /** How often the journal is read while waiting; the package's bus tails every 50 ms. */
  readonly pollMs?: number;
}

/** The request's id, and the reply's data; null when none came in time. */
export interface AskAnswer {
  readonly requestId: string;
  readonly reply: Record<string, unknown> | null;
}

/**
 * Emits `component/request` with `data` plus a fresh `requestId` and waits for `component/reply`
 * carrying that id. Answers the reply's data, or null when none came within `timeoutMs`. It reads
 * from the journal's end before it appends, so a fast reply cannot slip past. Never throws for a
 * slow or absent service; a journal it cannot write rejects.
 */
export async function ask(
  home: string,
  component: string,
  pair: { readonly request: string; readonly reply: string },
  data: Readonly<Record<string, unknown>>,
  options: AskOptions,
): Promise<AskAnswer> {
  const journal = join(home, "events.ndjson");
  const requestId = randomUUID();
  let offset = await size(journal);
  mkdirSync(home, { recursive: true });
  appendFileSync(
    journal,
    `${JSON.stringify(event(component, pair.request, "ask", { ...data, requestId }, "relay"))}\n`,
  );
  const replyType = `${component}/${pair.reply}`;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const { lines, next } = await readFrom(journal, offset);
    offset = next;
    for (const line of lines) {
      if (!line.includes(requestId)) continue;
      try {
        const parsed = JSON.parse(line) as Partial<AgentEvent>;
        const reply = parsed.data as Record<string, unknown> | null | undefined;
        if (
          parsed.type === replyType &&
          typeof reply === "object" &&
          reply !== null &&
          reply["requestId"] === requestId
        )
          return { requestId, reply };
      } catch {
        // A torn or hand-edited line is not the reply.
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { requestId, reply: null };
    await sleep(Math.min(options.pollMs ?? 50, left));
  }
}

/** `<home>/config.json` as JSON, or null when it is missing or unreadable (the service then runs on its code defaults). */
export function readConfig(home: string): unknown {
  const file = join(home, "config.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}
