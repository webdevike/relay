// Who ran a top-level omp session, from what this host already records about the sessions it
// starts. Read once per usage scan; every source is optional and a missing or bad file adds nothing.
//   - assistant threads: `<relay config>/assistants/<id>.json` (`sessionFile` and `history`, store.ts)
//   - agent sessions: `<agentHome>/work/eva/agent-sessions/*.json` (`owner`, `agent`, `sessionFile`,
//     `sessionFiles`, `rotations[].from|to`; Eva's `.omp/tools/agent-session.ts`)
//   - sessions an assistant started: `<agentHome>/work/eva/agents/<id>/sessions.json` (owned-sessions.ts)
//   - jobs: `<agentHome>/jobs/<name>/job.md` frontmatter `agent:` (the assistant a job reports to)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const File = z.string().startsWith("/");

const ThreadRecord = z.object({ sessionFile: File.optional(), history: z.array(File).catch([]) });
const AgentRun = z.object({
  owner: z.string().min(1).nullish(),
  agent: z.string().min(1).nullish(),
  sessionFile: File.nullish(),
  sessionFiles: z.array(File).catch([]),
  rotations: z.array(z.object({ from: File.optional(), to: File.optional() })).catch([]),
});
const OwnedEntry = z.object({ sessionFile: File });

/** A top-level session this host knows the runner of. */
export interface KnownSession {
  /** `assistant`: the assistant's own thread; `session`: a session an assistant started. */
  readonly kind: "assistant" | "session";
  /** The assistant id (assistant), or the omp agent the session runs (`session` for the default). */
  readonly agent: string;
  /** The assistant a started session works for; null for a thread. */
  readonly owner: string | null;
}

export interface SessionOwners {
  /** Absolute transcript path to its runner. */
  readonly sessions: ReadonlyMap<string, KnownSession>;
  /** Job name to the assistant it reports to. */
  readonly jobs: ReadonlyMap<string, string>;
}

/** The JSON in `path`, or undefined when it cannot be read or parsed. */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Everything the host records about who ran which session. */
export function readSessionOwners(agentHome: string | null, assistantsDir: string | null): SessionOwners {
  const sessions = new Map<string, KnownSession>();
  const add = (file: string, known: KnownSession): void => {
    // A thread outranks a record that also lists its file; the first record of a file wins.
    if (!sessions.has(file)) sessions.set(file, known);
  };
  if (assistantsDir !== null) {
    for (const name of list(assistantsDir)) {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!ID.test(id)) continue; // also skips `<id>.asks.json`
      const record = ThreadRecord.safeParse(readJson(join(assistantsDir, name)));
      if (!record.success) continue;
      const { history, sessionFile } = record.data;
      for (const file of sessionFile === undefined ? history : [...history, sessionFile]) add(file, { kind: "assistant", agent: id, owner: null });
    }
  }
  const jobs = new Map<string, string>();
  if (agentHome === null) return { sessions, jobs };
  const runs = join(agentHome, "work", "eva", "agent-sessions");
  for (const name of list(runs)) {
    if (!name.endsWith(".json")) continue;
    const run = AgentRun.safeParse(readJson(join(runs, name)));
    if (!run.success) continue;
    const { owner, agent, sessionFile, sessionFiles, rotations } = run.data;
    const files = [...sessionFiles, ...rotations.flatMap((rotation) => [rotation.from, rotation.to])];
    if (sessionFile !== null && sessionFile !== undefined) files.push(sessionFile);
    for (const file of files) if (file !== undefined) add(file, { kind: "session", agent: agent ?? "session", owner: owner ?? null });
  }
  const agents = join(agentHome, "work", "eva", "agents");
  for (const id of list(agents)) {
    if (!ID.test(id)) continue;
    const entries = readJson(join(agents, id, "sessions.json"));
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const owned = OwnedEntry.safeParse(entry);
      if (owned.success) add(owned.data.sessionFile, { kind: "session", agent: "session", owner: id });
    }
  }
  const jobsDir = join(agentHome, "jobs");
  for (const job of list(jobsDir)) {
    if (!ID.test(job)) continue;
    let head: string;
    try {
      head = readFileSync(join(jobsDir, job, "job.md"), "utf8").slice(0, 4000);
    } catch {
      continue;
    }
    const agent = /^---\n[\s\S]*?^agent:\s*([a-z0-9_-]+)\s*$/m.exec(head)?.[1];
    if (agent !== undefined) jobs.set(job, agent);
  }
  return { sessions, jobs };
}
