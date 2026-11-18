// Eva's specialist router in assistant threads (protocol `specialist-router.ts`): the router hook writes its
// decision for each of Isaac's messages, and the turn's outcome, as omp `custom` entries in the thread's
// transcript. Those entries never reach the bridge (omp's `appendEntry` fires no event), so the host reads
// them from the transcript files: `RouterLog` keeps, per file, only the entries the fold needs (router records
// and user messages), reading just what was appended since the last look, and hands them to the protocol's
// `routerByUserMessage`. Rows are matched to Isaac's rows by the user message's timestamp (`at`), which the
// bridge's live rows and the file's rows share.

import { closeSync, openSync, readSync, statSync, unwatchFile, watchFile } from "node:fs";
import {
  ROUTER_ENTRY_TYPE,
  routerByUserMessage,
  type AssistantMessage,
  type RouterTurn,
} from "@relay/protocol";

/** How often a followed transcript is polled for a new router entry (its outcome lands at the turn's end). */
export const ROUTER_POLL_MS = 1000;

const NEWLINE = 0x0a;

/** One file as read so far: the byte offset, an unfinished last line, the entries the fold needs, and the fold (null once stale). */
interface FileState {
  offset: number;
  partial: Buffer;
  entries: unknown[];
  turns: Map<number, RouterTurn> | null;
}

/** Whether a transcript line can matter to the fold: a router record or a user message (checked again once parsed). */
function wanted(line: string): boolean {
  return (
    line.includes(ROUTER_ENTRY_TYPE) ||
    (line.includes('"type":"message"') && line.includes('"role":"user"'))
  );
}

/** Isaac's rows with the router's turn their message got (matched by `at`); other rows, and rows with none, unchanged. */
export function withRouter(
  messages: readonly AssistantMessage[],
  turns: ReadonlyMap<number, RouterTurn>,
): AssistantMessage[] {
  if (turns.size === 0) return [...messages];
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const router = turns.get(message.at);
    return router === undefined ? message : { ...message, router };
  });
}

export class RouterLog {
  private readonly files = new Map<string, FileState>();
  private followed: string | null = null;
  private onRouter: (() => void) | null = null;

  /** The router's turns in `file` by the judged message's timestamp; empty when the file cannot be read. */
  turns(file: string): ReadonlyMap<number, RouterTurn> {
    const state = this.read(file);
    if (state === null) return new Map();
    if (state.turns === null) {
      state.turns = new Map();
      for (const turn of routerByUserMessage(state.entries).values()) {
        if (turn.at === undefined) continue;
        state.turns.set(turn.at, {
          decision: turn.decision,
          ...(turn.outcome === undefined ? {} : { outcome: turn.outcome }),
        });
      }
    }
    return state.turns;
  }

  /** Drops what was read of files no longer shown. */
  keep(files: readonly string[]): void {
    for (const file of [...this.files.keys()]) if (!files.includes(file)) this.files.delete(file);
  }

  /**
   * Polls `file` (the live session's transcript; null stops) and calls `listener` when a router entry was
   * appended to it, so an outcome written at the turn's end redraws the thread.
   */
  follow(file: string | null, listener: () => void): void {
    this.onRouter = listener;
    if (file === this.followed) return;
    this.stop();
    if (file === null) return;
    this.followed = file;
    watchFile(file, { interval: ROUTER_POLL_MS, persistent: false }, () => {
      const state = this.files.get(file);
      const before = state?.entries.length ?? 0;
      const after = this.read(file);
      if (after === null || after.entries.length === before) return;
      if (after.entries.slice(before).some((entry) => routerEntry(entry))) this.onRouter?.();
    });
  }

  stop(): void {
    if (this.followed !== null) unwatchFile(this.followed);
    this.followed = null;
  }

  /** `file`'s state with whatever was appended since the last read folded in; a file that shrank is read again from the top. */
  private read(file: string): FileState | null {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return null;
    }
    let state = this.files.get(file);
    if (state === undefined || size < state.offset) {
      state = { offset: 0, partial: Buffer.alloc(0), entries: [], turns: null };
      this.files.set(file, state);
    }
    if (size === state.offset) return state;
    const chunk = Buffer.alloc(size - state.offset);
    let fd: number;
    try {
      fd = openSync(file, "r");
    } catch {
      return state;
    }
    try {
      readSync(fd, chunk, 0, chunk.length, state.offset);
    } finally {
      closeSync(fd);
    }
    state.offset = size;
    const bytes = state.partial.length === 0 ? chunk : Buffer.concat([state.partial, chunk]);
    const end = bytes.lastIndexOf(NEWLINE);
    state.partial = end < 0 ? bytes : bytes.subarray(end + 1);
    if (end < 0) return state;
    let added = false;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      if (!wanted(line)) continue;
      try {
        state.entries.push(JSON.parse(line));
        added = true;
      } catch {
        // a malformed line: skipped
      }
    }
    if (added) state.turns = null;
    return state;
  }
}

function routerEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "customType" in entry &&
    entry.customType === ROUTER_ENTRY_TYPE
  );
}
