// The work a call request waits on, and how to tell that it settled. Three kinds:
//   - run:     an Eva agent-session run (`<agentHome>/work/eva/agent-sessions/<id>.json`, written by
//              `.omp/tools/agent-session.ts`); settled once its state is done, failed, timeout or stopped.
//   - session: an omp session the host lists (the assistant's own turn, a helper, a job); settled once
//              it stops working and none of its background jobs or subagents still run.
//   - manual:  settled only by `call-me settle` (a CI build, anything the host cannot see).

import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { untagged, type AgentSession } from "@relay/protocol";
import { z } from "zod";
import type { WorkOutcome } from "./callRequest.machine";

export const WorkTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run"), id: z.string().min(1), title: z.string() }),
  z.object({ kind: z.literal("session"), id: z.string().min(1), title: z.string() }),
  z.object({ kind: z.literal("manual") }),
]);
export type WorkTarget = z.infer<typeof WorkTarget>;

/** A result read back for the thread and the call's brief is cut to this many characters. */
export const MAX_RESULT = 1_500;
/** How much of a transcript's tail is read for its last reply. */
const TAIL_BYTES = 256 * 1024;

const RunRecord = z.object({
  id: z.string(),
  owner: z.string(),
  title: z.string(),
  state: z.enum(["starting", "running", "done", "failed", "timeout", "stopped"]),
  note: z.string().nullish(),
  sessionFile: z.string().nullish(),
});
export type RunRecord = z.infer<typeof RunRecord>;

const FAILED_RUN = { failed: "failed", timeout: "timed out", stopped: "was stopped" } as const;

/** Where agent-session runs keep their records. */
export function runsDir(agentHome: string): string {
  return join(agentHome, "work", "eva", "agent-sessions");
}

export function readRun(dir: string, id: string): RunRecord | null {
  if (!/^[\w.-]+$/.test(id)) return null;
  try {
    const parsed = RunRecord.safeParse(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Runs of `owner` still going, newest first. */
export function runningRuns(dir: string, owner: string): RunRecord[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .sort()
    .reverse()
    .flatMap((name) => {
      const run = readRun(dir, name.slice(0, -".json".length));
      return run !== null && run.owner === owner && (run.state === "running" || run.state === "starting") ? [run] : [];
    });
}

/** The last assistant reply in an omp transcript, cut to MAX_RESULT; "" when there is none. */
export function lastReply(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, size - length);
    const lines = bytes.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.includes('"role":"assistant"')) continue;
      try {
        const entry = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; content?: unknown } };
        if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
        const text = (entry.message.content as { type?: unknown; text?: unknown }[])
          .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
          .join("\n")
          .trim();
        if (text !== "") return clip(untagged(text));
      } catch {
        // the first line of the tail is cut
      }
    }
    return "";
  } finally {
    closeSync(fd);
  }
}

export function clip(text: string, max = MAX_RESULT): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** How run `run` ended; null while it still runs. */
export function runOutcome(run: RunRecord): WorkOutcome | null {
  if (run.state === "running" || run.state === "starting") return null;
  const reply = run.sessionFile == null ? "" : lastReply(run.sessionFile);
  if (run.state === "done") return { status: "done", result: reply === "" ? (run.note ?? "") : reply };
  const why = `"${run.title}" ${FAILED_RUN[run.state]}${run.note ? ` (${run.note})` : ""}.`;
  return { status: "failed", result: clip(reply === "" ? why : `${why} ${reply}`) };
}

/** Whether `session` is done with its work: not working, nothing of its own still running. */
export function sessionSettled(session: AgentSession, all: readonly AgentSession[]): boolean {
  if (session.status === "working" || session.status === "needs_permission") return false;
  if (session.backgroundJobs?.some((job) => job.state === "running") === true) return false;
  return !all.some((child) => child.parentId === session.id && (child.status === "working" || child.status === "needs_permission"));
}

/** How session `id` ended; null while it works. A session that left the list ended with what it last said. */
export function sessionOutcome(id: string, all: readonly AgentSession[], last: AgentSession | undefined): WorkOutcome | null {
  const session = all.find((candidate) => candidate.id === id);
  if (session !== undefined && !sessionSettled(session, all)) return null;
  const seen = session ?? last;
  const file = seen?.sessionFile;
  const reply = file === undefined ? "" : lastReply(file);
  return { status: "done", result: reply || clip(untagged(seen?.lastActivity ?? "")) };
}
