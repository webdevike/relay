// The window mirror (protocol workspace.ts): the entries every Relay Desktop shows (app tabs, each
// workspace's panes, web pages), kept by the host so the Macs show the same thing. Merged per key,
// last writer wins; the values are the desktops' and never read here. Kept in
// `$XDG_CONFIG_HOME/relay/workspace.json` (dir 0700, file 0600, written atomically), a moment after
// each change so a pane drag does not write the file on every step.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MAX_WORKSPACE_BYTES, WorkspaceEntries, type ServerMessage } from "@relay/protocol";

const WorkspaceFile = z.object({
  rev: z.number().int().nonnegative(),
  entries: WorkspaceEntries,
});
type WorkspaceFile = z.infer<typeof WorkspaceFile>;

/** `$XDG_CONFIG_HOME/relay/workspace.json`. */
export function defaultWorkspacePath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "workspace.json");
}

export type WorkspaceChanged = Extract<ServerMessage, { t: "workspace.changed" }>;

export interface WorkspacePut {
  readonly origin: string;
  readonly set: Readonly<Record<string, unknown>>;
  readonly del: readonly string[];
  readonly seed?: boolean | undefined;
}

/** What a session needs of the mirror. */
export interface WorkspaceRelaying {
  /** Every entry and the rev they are at (0 while the host holds nothing). */
  snapshot(): { rev: number; entries: Record<string, unknown> };
  /**
   * Merges a put. `applied` false: a seed while the host holds entries, or a result over
   * MAX_WORKSPACE_BYTES. `changed`: the frame for every other subscribed socket, null when nothing
   * changed (the rev stays).
   */
  put(put: WorkspacePut): { rev: number; applied: boolean; changed: WorkspaceChanged | null };
}

export interface WorkspaceServiceDeps {
  readonly path: string;
  readonly log: (line: string) => void;
  /** How long after a change the file is written (tests pass 0 for a write at once). */
  readonly saveDelayMs?: number;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class WorkspaceService implements WorkspaceRelaying {
  private state: WorkspaceFile;
  private timer: Timer | null = null;

  constructor(private readonly deps: WorkspaceServiceDeps) {
    this.state = this.load();
  }

  snapshot(): { rev: number; entries: Record<string, unknown> } {
    return { rev: this.state.rev, entries: this.state.entries };
  }

  put(put: WorkspacePut): { rev: number; applied: boolean; changed: WorkspaceChanged | null } {
    const { rev, entries } = this.state;
    if (put.seed === true && Object.keys(entries).length > 0)
      return { rev, applied: false, changed: null };
    const next: Record<string, unknown> = { ...entries };
    const set: Record<string, unknown> = {};
    const del: string[] = [];
    for (const [key, value] of Object.entries(put.set)) {
      if (value === null || value === undefined || same(entries[key], value)) continue;
      next[key] = value;
      set[key] = value;
    }
    for (const key of put.del) {
      if (!(key in next) || key in set) continue;
      delete next[key];
      del.push(key);
    }
    if (Object.keys(set).length === 0 && del.length === 0)
      return { rev, applied: true, changed: null };
    if (JSON.stringify(next).length > MAX_WORKSPACE_BYTES) {
      this.deps.log(
        `workspace: refused a put from ${put.origin}: over ${MAX_WORKSPACE_BYTES} bytes`,
      );
      return { rev, applied: false, changed: null };
    }
    this.state = { rev: rev + 1, entries: next };
    this.scheduleSave();
    return {
      rev: rev + 1,
      applied: true,
      changed: { t: "workspace.changed", rev: rev + 1, origin: put.origin, set, del },
    };
  }

  /** Writes a pending change now (the host is stopping). */
  flush(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.save();
  }

  private scheduleSave(): void {
    const delay = this.deps.saveDelayMs ?? 500;
    if (delay === 0) {
      this.save();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.save();
    }, delay);
  }

  private load(): WorkspaceFile {
    const empty: WorkspaceFile = { rev: 0, entries: {} };
    if (!existsSync(this.deps.path)) return empty;
    try {
      const parsed = WorkspaceFile.safeParse(JSON.parse(readFileSync(this.deps.path, "utf8")));
      if (parsed.success) return parsed.data;
      this.deps.log(`workspace: ${this.deps.path} is not a workspace file; starting empty`);
    } catch (error) {
      this.deps.log(
        `workspace: cannot read ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return empty;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.deps.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.deps.path);
    } catch (error) {
      this.deps.log(
        `workspace: cannot save ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
