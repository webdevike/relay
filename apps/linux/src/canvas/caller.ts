// Which omp session ran `relay-linux canvas start`, and which chat it belongs to. The CLI runs as
// a bash tool call under an omp process; that process holds its session files open. A subagent
// runs inside its parent's process and its transcript lives in a folder named after its parent's
// file (`<chat>.jsonl` -> `<chat>/<Task>.jsonl` -> `<chat>/<Task>/<Task.Sub>.jsonl`), so:
//   caller = the newest-written open `.jsonl` (the session whose tool call is running now),
//   chat   = its top-level owner (walk up the folders while `<folder>.jsonl` exists).
// Ported from relay-ctl's detectScope/topSessionFile (~/Eva/.omp/tools/relay-ctl.ts).

import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** One ancestor process: its pid and full command line. */
export interface Proc {
  readonly pid: number;
  readonly args: string;
}

export interface CallerDeps {
  readonly env: Record<string, string | undefined>;
  /** This process's ancestors, nearest first. */
  readonly ancestors: () => Proc[];
  /** Files a process holds open. */
  readonly openFiles: (pid: number) => string[];
  readonly mtime: (file: string) => number;
  readonly exists: (file: string) => boolean;
}

export interface Caller {
  /** The transcript of the session that ran the command. */
  readonly sessionFile: string;
  /** The top-level chat that owns it (equal to `sessionFile` unless a subagent ran the command). */
  readonly chatFile: string;
  /** `$RELAY_ASSISTANT` when set: the assistant thread the command ran in. */
  readonly assistant?: string;
  /** Where it was found, for the CLI's stderr line. */
  readonly source: string;
}

/** The session file an omp command line names (`--resume=<f>`, `--resume <f>`, `--session <f>`). */
export function sessionArg(args: string): string | null {
  const m = /(?:^|\s)--(?:resume|session)(?:=|\s+)(\/\S+\.jsonl)(?=\s|$)/.exec(args);
  return m?.[1] ?? null;
}

/** The top-level chat owning `file`: up through `<dir>.jsonl` parents while they exist. */
export function chatFileOf(file: string, exists: (file: string) => boolean = existsSync): string {
  let current = file;
  for (let depth = 0; depth < 8; depth++) {
    const parent = `${dirname(current)}.jsonl`;
    if (!exists(parent)) return current;
    current = parent;
  }
  return current;
}

/** A subagent's display name from its transcript: `LiveCanvasBuild.HostSlice.jsonl` -> `HostSlice`. */
export function subagentName(file: string): string {
  const stem = basename(file, ".jsonl");
  return stem.slice(stem.lastIndexOf(".") + 1) || stem;
}

/**
 * The calling session among the `.jsonl` session files an omp process holds open: the one written
 * last (a subagent working right now beats its waiting parent). Null when it holds none.
 */
export function callerFile(open: readonly string[], mtime: (file: string) => number): string | null {
  const files = [...new Set(open.filter((f) => f.endsWith(".jsonl") && f.includes("/sessions/")))];
  if (files.length === 0) return null;
  return files.reduce((a, b) => (mtime(b) > mtime(a) ? b : a));
}

/**
 * Whether command line `args` runs omp: `omp ...` everywhere; on Linux also a Nix-wrapped omp
 * (`.omp-wrapped`) and omp run by its interpreter (`bun /.../omp`, `node /.../@oh-my-pi/.../cli.js`).
 */
export function isOmpCommand(args: string, platform: NodeJS.Platform = process.platform): boolean {
  const [first = "", second = ""] = args.split(/\s+/);
  if (basename(first) === "omp") return true;
  if (platform === "darwin") return false;
  const omp = (word: string): boolean => /^\.?omp(?:-wrapped)?$/.test(basename(word));
  if (omp(first)) return true;
  const interpreter = /^\.?(?:bun|node)(?:-wrapped)?$/.test(basename(first));
  return interpreter && (omp(second) || /\/(?:@oh-my-pi|oh-my-pi)\//.test(second));
}

/** The caller of this CLI, or null when it is not running under an omp session. */
export function detectCaller(deps: CallerDeps): Caller | null {
  const assistantEnv = deps.env["RELAY_ASSISTANT"]?.trim();
  const assistant = assistantEnv === undefined || assistantEnv === "" ? {} : { assistant: assistantEnv };
  const omp = deps.ancestors().find((p) => isOmpCommand(p.args));
  if (omp === undefined) return null;
  const file = callerFile(deps.openFiles(omp.pid), deps.mtime) ?? sessionArg(omp.args);
  if (file === null) return null;
  return { sessionFile: file, chatFile: chatFileOf(file, deps.exists), ...assistant, source: `omp session (pid ${String(omp.pid)})` };
}

function run(cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

/** Linux: `pid`'s parent and argv from /proc (no ps/lsof needed); null when /proc does not have it. */
function procEntry(pid: number): { ppid: number; args: string } | null {
  try {
    // `pid (comm) state ppid ...`: comm may hold spaces and parens, so read after its last `)`.
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const args = readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0").filter((arg) => arg !== "").join(" ");
    return Number.isInteger(ppid) ? { ppid, args } : null;
  } catch {
    return null;
  }
}

const useProc = process.platform === "linux" && existsSync("/proc/self/stat");

/** The live process tree and file table: /proc on Linux, else ps and lsof. */
export const systemCallerDeps: CallerDeps = {
  env: process.env,
  ancestors() {
    const out: Proc[] = [];
    let pid = process.ppid;
    for (let i = 0; i < 16 && pid > 1; i++) {
      if (useProc) {
        const entry = procEntry(pid);
        if (entry === null) break;
        out.push({ pid, args: entry.args });
        pid = entry.ppid;
        continue;
      }
      const line = run(["ps", "-o", "ppid=,args=", "-p", String(pid)]).trim();
      const m = /^(\d+)\s+(.*)$/.exec(line);
      if (!m) break;
      out.push({ pid, args: m[2] ?? "" });
      pid = Number(m[1]);
    }
    return out;
  },
  openFiles(pid) {
    if (useProc) {
      const dir = `/proc/${String(pid)}/fd`;
      try {
        return readdirSync(dir).flatMap((fd) => {
          try {
            return [readlinkSync(join(dir, fd))];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    }
    return run(["lsof", "-a", "-p", String(pid), "-Fn"])
      .split("\n")
      .filter((l) => l.startsWith("n/"))
      .map((l) => l.slice(1));
  },
  mtime(file) {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  },
  exists: existsSync,
};
