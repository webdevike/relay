// Catch Up deck: the feed `catchup-build` writes in the Eva hub (`work/elysia/catchup.json`) plus
// the read state this host keeps per item in `$XDG_CONFIG_HOME/relay/catchup-state.json`. The feed
// file is watched (its directory, since the builder replaces it by rename) and every change of feed
// or read state goes out to all phones as one `catchup.snapshot`.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CatchUpFeed, type CatchUpItem, type CatchUpSnapshot } from "@relay/protocol";
import { z } from "zod";

/** Read marks for ids that left the feed are dropped after this long. */
export const CATCHUP_READ_TTL_MS = 30 * 86_400_000;
/** Coalesces the burst of events one atomic replace produces. */
export const CATCHUP_RELOAD_DEBOUNCE_MS = 150;

export const EMPTY_CATCHUP: CatchUpSnapshot = { items: [], unreadCount: 0 };

/** id -> ISO time it was marked read. */
const CatchUpState = z.object({ read: z.record(z.string().min(1), z.string()) });
type CatchUpState = z.infer<typeof CatchUpState>;

export function defaultCatchUpStatePath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "catchup-state.json");
}

/** The hub's feed: `RELAY_CATCHUP_FEED`, else `<agentHome>/work/elysia/catchup.json`. */
export function defaultCatchUpFeedPath(agentHome: string | null): string | null {
  const override = process.env["RELAY_CATCHUP_FEED"];
  if (override !== undefined && override !== "") return override;
  return agentHome === null ? null : join(agentHome, "work", "elysia", "catchup.json");
}

export interface CatchUpServiceDeps {
  feedPath: string;
  statePath: string;
  /** Called with the new snapshot whenever the feed or read state changes. */
  emit: (snapshot: CatchUpSnapshot) => void;
  log: (line: string) => void;
  now?: () => number;
}

/** What a phone session needs from the deck. */
export interface CatchUpDeck {
  snapshot(): CatchUpSnapshot;
  /** false when nothing changed (unknown id, or already in that state); a change is emitted to every phone. */
  mark(id: string, read: boolean): boolean;
}

export class CatchUpService implements CatchUpDeck {
  private items: CatchUpItem[] = [];
  private state: CatchUpState;
  private watcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: CatchUpServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.state = this.loadState();
    this.loadFeed();
  }

  /** Every feed item in deck order (importance, then newest first) with its read flag. */
  snapshot(): CatchUpSnapshot {
    const items = [...this.items]
      .sort((a, b) => b.importance - a.importance || Date.parse(b.ts) - Date.parse(a.ts) || a.id.localeCompare(b.id))
      .map((item) => ({ ...item, read: item.id in this.state.read }));
    return { items, unreadCount: items.filter((item) => !item.read).length };
  }

  /** Records `read` for `id`; false when nothing changed (unknown id, or already in that state). */
  mark(id: string, read: boolean): boolean {
    if (!this.items.some((item) => item.id === id)) return false;
    if ((id in this.state.read) === read) return false;
    const marks = Object.entries(this.state.read).filter(([marked]) => marked !== id);
    if (read) marks.push([id, new Date(this.now()).toISOString()]);
    this.state = { read: Object.fromEntries(marks) };
    this.persistState();
    this.deps.emit(this.snapshot());
    return true;
  }

  /** Re-reads the feed; emits when the snapshot changed. */
  reload(): void {
    const before = JSON.stringify(this.snapshot());
    this.loadFeed();
    const after = this.snapshot();
    if (JSON.stringify(after) !== before) this.deps.emit(after);
  }

  /** Watches the feed's directory; a missing directory is logged and leaves the deck as loaded. */
  start(): void {
    const dir = dirname(this.deps.feedPath);
    const name = basename(this.deps.feedPath);
    if (!existsSync(dir)) {
      this.deps.log(`catchup: ${dir} missing, feed not watched`);
      return;
    }
    try {
      this.watcher = watch(dir, (_event, filename) => {
        if (filename !== null && filename !== name) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => {
          this.reloadTimer = undefined;
          this.reload();
        }, CATCHUP_RELOAD_DEBOUNCE_MS);
      });
      this.watcher.on("error", (error) => {
        this.deps.log(`catchup: watch failed: ${error.message}`);
      });
    } catch (error) {
      this.deps.log(`catchup: cannot watch ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
  }

  /** A missing feed is an empty deck; an unreadable or invalid one keeps the last good items. */
  private loadFeed(): void {
    if (!existsSync(this.deps.feedPath)) {
      this.items = [];
      return;
    }
    try {
      const parsed = CatchUpFeed.safeParse(JSON.parse(readFileSync(this.deps.feedPath, "utf8")));
      if (!parsed.success) {
        this.deps.log(`catchup: ${this.deps.feedPath} invalid: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
        return;
      }
      this.items = parsed.data.items;
    } catch (error) {
      this.deps.log(`catchup: cannot read ${this.deps.feedPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private loadState(): CatchUpState {
    if (!existsSync(this.deps.statePath)) return { read: {} };
    try {
      const parsed = CatchUpState.safeParse(JSON.parse(readFileSync(this.deps.statePath, "utf8")));
      if (parsed.success) return parsed.data;
      this.deps.log(`catchup: ${this.deps.statePath} invalid, starting with nothing read`);
    } catch (error) {
      this.deps.log(`catchup: cannot read ${this.deps.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { read: {} };
  }

  /** Writes the read marks, dropping old ones for ids no longer in the feed. */
  private persistState(): void {
    const live = new Set(this.items.map((item) => item.id));
    const cutoff = this.now() - CATCHUP_READ_TTL_MS;
    const read = Object.fromEntries(Object.entries(this.state.read).filter(([id, at]) => live.has(id) || Date.parse(at) >= cutoff));
    this.state = { read };
    mkdirSync(dirname(this.deps.statePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.deps.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.deps.statePath);
  }
}
