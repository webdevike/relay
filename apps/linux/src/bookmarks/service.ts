// Bookmarks on chat turns (the turn navigator): the host keeps one set per thread
// (`assistant:<id>` or `session:<omp session id>`), each a turn's `ReactionKey`, so Relay desktop and
// the phone agree. Kept in `$XDG_CONFIG_HOME/relay/bookmarks.json` (dir 0700, file 0600, written
// atomically); every change goes out to every device as the thread's `bookmarks.snapshot`. A
// bookmark never reaches an agent: no note, no turn, no push.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MAX_BOOKMARKS, ReactionKey, ThreadBookmarks, type ServerMessage } from "@relay/protocol";

const BookmarkState = z.object({
  /** Every thread's bookmarked turns, oldest first. */
  threads: z.record(z.string(), ThreadBookmarks).default({}),
});
type BookmarkState = z.infer<typeof BookmarkState>;

/** `$XDG_CONFIG_HOME/relay/bookmarks.json`. */
export function defaultBookmarksPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "relay", "bookmarks.json");
}

export interface BookmarkServiceDeps {
  readonly path: string;
  /** Sends `message` to every authenticated device. */
  readonly broadcast: (message: ServerMessage) => void;
  readonly log: (line: string) => void;
}

/** What a phone session and the server need of the bookmarks. */
export interface BookmarkRelaying {
  /** `thread`'s bookmarked turns, oldest first. */
  snapshot(thread: string): readonly string[];
  /** Bookmarks (`on`) or unbookmarks turn `key` of `thread`; false when it already was so, or `key` is no reaction key. */
  set(thread: string, key: string, on: boolean): boolean;
}

export class BookmarkService implements BookmarkRelaying {
  private state: BookmarkState;

  constructor(private readonly deps: BookmarkServiceDeps) {
    this.state = this.load();
  }

  snapshot(thread: string): readonly string[] {
    return this.state.threads[thread] ?? [];
  }

  set(thread: string, key: string, on: boolean): boolean {
    if (!ReactionKey.safeParse(key).success) return false;
    const have = this.snapshot(thread);
    if (have.includes(key) === on) return false;
    const next = on ? [...have, key].slice(-MAX_BOOKMARKS) : have.filter((k) => k !== key);
    this.state.threads =
      next.length === 0
        ? Object.fromEntries(
            Object.entries(this.state.threads).filter(([other]) => other !== thread),
          )
        : { ...this.state.threads, [thread]: next };
    this.save();
    this.deps.broadcast({ t: "bookmarks.snapshot", thread, messages: [...this.snapshot(thread)] });
    this.deps.log(`bookmarks: ${on ? "marked" : "cleared"} ${thread} ${key}`);
    return true;
  }

  private load(): BookmarkState {
    const empty: BookmarkState = { threads: {} };
    if (!existsSync(this.deps.path)) return empty;
    try {
      const parsed = BookmarkState.safeParse(JSON.parse(readFileSync(this.deps.path, "utf8")));
      if (parsed.success) return parsed.data;
      this.deps.log(`bookmarks: ${this.deps.path} is not a bookmarks file; starting empty`);
    } catch (error) {
      this.deps.log(
        `bookmarks: cannot read ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`,
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
        `bookmarks: cannot save ${this.deps.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
