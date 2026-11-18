// A board file `<slug>.json` written by more than one process on the Mini: the Mini's Relay Desktop
// (its own boards folder) and the Relay Host (for desktops on other Macs, protocol canvas-files.ts).
// Each writer reads the board, changes it and writes it back; a write that names the revision it
// read (`ifRevision`) lands only when the file still is that revision, so a writer that read before
// another one wrote never puts its stale copy over that write. It reads again and redoes its change
// instead. The check and the rename run under `<slug>.json.lock`, which every writer takes, so no
// other write can land between them.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** The revision of a board that is not there: a write naming it only creates the board. */
export const NO_BOARD = "none";

/** How long a lock may be held before it counts as left behind by a writer that died. */
export const STALE_LOCK_MS = 10_000;
/** The longest a writer waits for another one's lock. */
export const LOCK_WAIT_MS = 5_000;
const RETRY_MS = 10;

/** The file changed since the writer read it: nothing was written. */
export class BoardConflict extends Error {
  readonly code = "conflict";
  constructor(message = "The board changed since it was read.") {
    super(message);
    this.name = "BoardConflict";
  }
}

/** A board text's revision (sha1 hex); NO_BOARD for null. */
export function boardRevision(text: string | null): string {
  return text === null ? NO_BOARD : createHash("sha1").update(text).digest("hex");
}

export interface BoardWrite {
  /** Write only when the file is still this revision (boardRevision); else throws BoardConflict. */
  readonly ifRevision?: string | undefined;
  /** Runs right before the new text replaces the file; throws to write nothing. */
  readonly commit?: (() => void) | undefined;
}

async function currentText(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Takes `<file>.lock` (O_EXCL), breaking one older than STALE_LOCK_MS. Answers the release. */
async function lock(file: string): Promise<() => Promise<void>> {
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = await fs.promises.open(lockFile, "wx");
      await fd.close();
      return () => fs.promises.rm(lockFile, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      const { mtimeMs } = await fs.promises.stat(lockFile);
      if (Date.now() - mtimeMs > STALE_LOCK_MS) {
        await fs.promises.rm(lockFile, { force: true });
        continue;
      }
    } catch {
      continue; // Released between the open and the stat.
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error(`${path.basename(file)} stayed locked by another writer.`), {
        code: "timeout",
      });
    }
    await sleep(RETRY_MS);
  }
}

/**
 * Replaces the board file `file` with `text` atomically (a temp file renamed over it), under the
 * board's lock. With `ifRevision` the file must still be that revision, else BoardConflict and
 * nothing changes.
 */
export async function writeBoardFile(
  file: string,
  text: string,
  opts: BoardWrite = {},
): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${String(process.pid)}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  await fs.promises.writeFile(tmp, text, "utf8");
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lock(file);
    if (
      opts.ifRevision !== undefined &&
      boardRevision(await currentText(file)) !== opts.ifRevision
    ) {
      throw new BoardConflict();
    }
    // Synchronous right after `commit`, so nothing runs between its check and the file changing.
    opts.commit?.();
    fs.renameSync(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true });
    throw error;
  } finally {
    await release?.();
  }
}
