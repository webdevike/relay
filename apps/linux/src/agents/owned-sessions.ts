// Sessions an assistant started that never reached the bridge, read from the assistant's own record.
//
// Each assistant lists the sessions it starts (auto-work, delegated project work) in
// `<agent home>/work/eva/agents/<id>/sessions.json` (`.omp/tools/eva-project.ts registerSession`), and
// marks one `closedAt` once its job no longer needs it. A session normally also reports to this host
// through the omp extension; one started without the extension (a profiled omp does not discover it
// on its own) is only in that record and in its transcript. The mirrors register it from there, as the
// helpers' file mirrors do, so Relay lists it under its assistant and its helpers follow. Only files
// inside an omp `sessions` folder are read.
import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

/** An open session written this recently is listed; older ones the assistant never closed are not. */
export const OWNED_RECENT_MS = 6 * 60 * 60 * 1000;
/** A transcript written this recently is mid-turn; a quieter one is idle. */
export const OWNED_WORKING_MS = 3 * 60 * 1000;
/** How much of a transcript's head is read for its working folder. */
const HEAD_BYTES = 8 * 1024;
const ID = /_([0-9a-f]{8}-[0-9a-f-]{20,})\.jsonl$/;
const ASSISTANT = /^[a-z0-9][a-z0-9_-]*$/;

const Entry = z.object({
  sessionFile: z.string().startsWith("/").includes("/sessions/"),
  title: z.string().optional(),
  startedAt: z.string().optional(),
  closedAt: z.string().nullish(),
});
const Header = z.object({ type: z.literal("session"), cwd: z.string().startsWith("/") });

/** One open session an assistant started. */
export interface OwnedSession {
  /** The omp session id (the transcript's own). */
  readonly id: string;
  /** The assistant that started it. */
  readonly owner: string;
  readonly file: string;
  readonly title: string;
  readonly projectPath: string;
  readonly startedAt: number;
  /** When the transcript was last written. */
  readonly updatedAt: number;
  readonly working: boolean;
}

/** The working folder in a transcript's head (`{"type":"session","cwd":...}`), or `fallback`. */
function cwdOf(file: string, fallback: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
      for (const line of head.split("\n").slice(0, 4)) {
        try {
          const header = Header.safeParse(JSON.parse(line));
          if (header.success) return header.data.cwd;
        } catch {
          // a line cut at HEAD_BYTES
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // unreadable: the fallback stands
  }
  return fallback;
}

/** Every assistant's open, recently written sessions that sit in an omp `sessions` folder, newest first. */
export function ownedSessions(agentHome: string, now: number): OwnedSession[] {
  const root = join(agentHome, "work", "eva", "agents");
  let owners: string[];
  try {
    owners = readdirSync(root).filter((name) => ASSISTANT.test(name));
  } catch {
    return [];
  }
  const out: OwnedSession[] = [];
  const seen = new Set<string>();
  for (const owner of owners) {
    let records: unknown[];
    try {
      records = z.array(z.unknown()).parse(JSON.parse(readFileSync(join(root, owner, "sessions.json"), "utf8")));
    } catch {
      continue; // none, mid-write, or not a list
    }
    for (const record of records) {
      const parsed = Entry.safeParse(record);
      if (!parsed.success) continue; // one malformed entry does not hide the others
      const entry = parsed.data;
      if (entry.closedAt !== undefined && entry.closedAt !== null && entry.closedAt !== "") continue;
      const id = ID.exec(entry.sessionFile)?.[1];
      if (id === undefined || seen.has(id)) continue;
      let mtime: number;
      try {
        mtime = statSync(entry.sessionFile).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime > OWNED_RECENT_MS) continue;
      seen.add(id);
      const started = Date.parse(entry.startedAt ?? "");
      out.push({
        id,
        owner,
        file: entry.sessionFile,
        title: entry.title !== undefined && entry.title !== "" ? entry.title : basename(entry.sessionFile, ".jsonl"),
        projectPath: cwdOf(entry.sessionFile, agentHome),
        startedAt: Number.isNaN(started) ? mtime : started,
        updatedAt: mtime,
        working: now - mtime < OWNED_WORKING_MS,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}
