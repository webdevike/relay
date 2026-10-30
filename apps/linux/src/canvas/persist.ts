// A room's board file, `<canvases>/<slug>.json`, kept in step with its Y.Doc. The file is the
// record: the doc is seeded from it, every change is exported back through `boardText` (byte for
// byte what EvaOS writes) after a short debounce, only when the text differs from what is on
// disk, and atomically (tmp + rename) so EvaOS and agents never read half a board. Writes by
// anyone else (an agent writing JSON, EvaOS' own editor) are picked up by a directory watcher and
// merged into the doc by node id against the board as this room last saw it on disk.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { boardText, CANVAS_VERSION, exportBoard, mergeBoardIntoDoc, parseBoard, seedDoc, type Board } from "@relay/canvas-live/board";
import type * as Y from "yjs";

/** Debounce of the export after a doc change. */
export const EXPORT_DEBOUNCE_MS = 400;
/** Longest a change waits for its export while edits keep coming (several agents typing at once). */
export const EXPORT_MAX_WAIT_MS = 2000;
/** Debounce of the watcher: editors write in bursts (tmp file, rename). */
const WATCH_DEBOUNCE_MS = 150;
/** Doc updates with this origin came from the file; they never trigger an export by themselves. */
export const FILE_ORIGIN = "file";

export function boardPath(dir: string, slug: string): string {
  return join(dir, `${slug}.json`);
}

export class BoardFile {
  /** The text on disk as this room last wrote or read it. */
  private diskText = "";
  /** `diskText` parsed: the base an outside write is merged against. */
  private diskBoard: Board = { version: CANVAS_VERSION, title: "", nodes: [], edges: [] };
  private exportTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the oldest change not yet exported came in; null when everything is written. */
  private dirtySince: number | null = null;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: FSWatcher | null = null;
  private closed = false;
  private readonly onUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === FILE_ORIGIN || this.closed) return;
    const now = Date.now();
    this.dirtySince ??= now;
    clearTimeout(this.exportTimer ?? undefined);
    this.exportTimer = setTimeout(
      () => {
        this.exportTimer = null;
        this.flush();
      },
      Math.max(0, Math.min(EXPORT_DEBOUNCE_MS, this.dirtySince + EXPORT_MAX_WAIT_MS - now)),
    );
  };

  constructor(
    private readonly dir: string,
    readonly slug: string,
    private readonly doc: Y.Doc,
    private readonly log: (line: string) => void,
  ) {}

  get path(): string {
    return boardPath(this.dir, this.slug);
  }

  /**
   * Seeds the doc from the file, creating the file with an empty board titled `title` when it does
   * not exist yet; then exports on change and watches for outside writes. Throws when the file
   * exists but is not a board this build reads.
   */
  open(title: string, options: { watch: boolean } = { watch: true }): { created: boolean } {
    const created = !existsSync(this.path);
    if (created) {
      mkdirSync(this.dir, { recursive: true });
      this.write(boardText({ version: CANVAS_VERSION, title, nodes: [], edges: [] }));
    } else {
      this.diskText = readFileSync(this.path, "utf8");
      this.diskBoard = parseBoard(this.diskText);
    }
    seedDoc(this.doc, this.diskBoard, FILE_ORIGIN);
    this.doc.on("update", this.onUpdate);
    if (options.watch) this.watch();
    return { created };
  }

  /** Writes the doc's board now when its text differs from what is on disk. */
  flush(): void {
    clearTimeout(this.exportTimer ?? undefined);
    this.exportTimer = null;
    this.dirtySince = null;
    const board = exportBoard(this.doc);
    const text = boardText(board);
    // A file another writer formatted differently but holding the same board is left alone.
    if (text === this.diskText || text === boardText(this.diskBoard)) return;
    this.write(text);
  }

  /** Re-reads the file now (the watcher calls this); merges an outside write into the doc. */
  reload(): void {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return; // deleted or mid-rename: the room keeps its doc and writes it back on the next change
    }
    if (text === this.diskText) return;
    let board: Board;
    try {
      board = parseBoard(text);
    } catch (error) {
      this.log(`canvas ${this.slug}: ignoring an unreadable outside write: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    mergeBoardIntoDoc(this.doc, board, FILE_ORIGIN, this.diskBoard);
    this.diskText = text;
    this.diskBoard = board;
    this.log(`canvas ${this.slug}: merged an outside write`);
    // The merged doc may differ from the file (typing the writer did not have): write that back.
    this.onUpdate(new Uint8Array(), null);
  }

  /** Final export, then stops exporting and watching. */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this.doc.off("update", this.onUpdate);
    this.watcher?.close();
    this.watcher = null;
    clearTimeout(this.watchTimer ?? undefined);
  }

  private write(text: string): void {
    // Hidden and not `*.json`, so board watchers (EvaOS, this one) never take it for a board.
    const tmp = join(this.dir, `.${this.slug}.json.${String(process.pid)}.tmp`);
    try {
      writeFileSync(tmp, text);
      renameSync(tmp, this.path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
    this.diskText = text;
    this.diskBoard = parseBoard(text);
  }

  private watch(): void {
    const name = `${this.slug}.json`;
    try {
      // The directory, not the file: atomic writers replace the file, which ends a file watch.
      this.watcher = watch(this.dir, (_event, file) => {
        if (file !== name || this.closed) return;
        clearTimeout(this.watchTimer ?? undefined);
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          if (!this.closed) this.reload();
        }, WATCH_DEBOUNCE_MS);
      });
    } catch (error) {
      this.log(`canvas ${this.slug}: cannot watch ${this.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
