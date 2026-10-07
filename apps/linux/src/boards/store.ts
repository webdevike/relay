// Live dashboards on disk: `<dir>/<slug>.json`, one pretty-printed `Board` per file. Files are read
// once at start (invalid ones are logged and skipped); afterwards memory is authoritative. Every
// write runs through one async queue: validate the whole result, persist it (tmp + rename), then
// commit it in memory, bump the global rev and report the change. A write that fails validation
// changes nothing, so a batch of ops lands all together or not at all.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Board, BoardOp, BoardPut, type BoardWidget, type ServerMessage } from "@relay/protocol";
import { z } from "zod";

export type BoardDelta = Extract<ServerMessage, { t: "board.delta" }>;
export type BoardSnapshot = Extract<ServerMessage, { t: "board.snapshot" }>;

/** A rejected request: 400 for an invalid body or op, 404 for an unknown board. */
export class BoardError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

const BoardOps = z.array(BoardOp).min(1);

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`)).join("; ");
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BoardError(400, issues(result.error));
  return result.data;
}

/** Applies `ops` in order to a copy of `board`; throws on an op that cannot apply. */
export function applyOps(board: Board, ops: readonly BoardOp[]): Board {
  let next: Board = { ...board, widgets: [...board.widgets] };
  for (const op of ops) {
    if (op.op === "meta") {
      next = {
        ...next,
        ...(op.title === undefined ? {} : { title: op.title }),
        ...(op.workspace === undefined ? {} : { workspace: op.workspace }),
        ...(op.icon === undefined ? {} : { icon: op.icon }),
      };
      continue;
    }
    const at = next.widgets.findIndex((widget) => widget.id === op.id);
    if (op.op === "remove") {
      if (at >= 0) next.widgets.splice(at, 1);
      continue;
    }
    const existing = at >= 0 ? next.widgets[at] : undefined;
    const widget: BoardWidget = { id: op.id, span: op.span ?? existing?.span ?? 12, spec: op.spec };
    if (op.after === undefined) {
      if (existing === undefined) next.widgets.push(widget);
      else next.widgets[at] = widget;
      continue;
    }
    if (op.after === op.id) throw new BoardError(400, `widget ${op.id} cannot go after itself`);
    if (at >= 0) next.widgets.splice(at, 1);
    if (op.after === null) {
      next.widgets.unshift(widget);
      continue;
    }
    const anchor = next.widgets.findIndex((other) => other.id === op.after);
    if (anchor < 0) throw new BoardError(400, `no widget ${op.after} to place ${op.id} after`);
    next.widgets.splice(anchor + 1, 0, widget);
  }
  return next;
}

export class FileBoardStore {
  /** Called after every committed write, in rev order. */
  onChange: ((delta: BoardDelta) => void) | null = null;
  private readonly boards = new Map<string, Board>();
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    log: (line: string) => void,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
      const path = join(dir, name);
      try {
        const board = Board.parse(JSON.parse(readFileSync(path, "utf8")));
        if (`${board.slug}.json` !== name) throw new Error(`slug ${board.slug} does not match the file name`);
        this.boards.set(board.slug, board);
      } catch (error) {
        log(`boards: skipping ${path}: ${error instanceof z.ZodError ? issues(error) : error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  get rev(): number {
    return this.revision;
  }

  snapshot(): BoardSnapshot {
    return { t: "board.snapshot", rev: this.revision, boards: this.list() };
  }

  list(): Board[] {
    return [...this.boards.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(slug: string): Board | null {
    return this.boards.get(slug) ?? null;
  }

  /** Creates or replaces `slug` from a `BoardPut` body. */
  put(slug: string, body: unknown): Promise<Board> {
    return this.enqueue(async () => {
      const put = parse(BoardPut, body);
      return this.write({
        // `write` validates the slug (via `Board`) before it touches a path.
        slug,
        title: put.title,
        ...(put.workspace === undefined ? {} : { workspace: put.workspace }),
        ...(put.icon === undefined ? {} : { icon: put.icon }),
        widgets: put.widgets ?? [],
        updatedAt: "",
      });
    });
  }

  /** Applies a `BoardOp[]` body to an existing board, all or nothing. */
  apply(slug: string, body: unknown): Promise<Board> {
    return this.enqueue(async () => {
      const current = this.boards.get(slug);
      if (current === undefined) throw new BoardError(404, `no board ${slug}`);
      return this.write(applyOps(current, parse(BoardOps, body)));
    });
  }

  remove(slug: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.boards.has(slug)) throw new BoardError(404, `no board ${slug}`);
      await rm(join(this.dir, `${slug}.json`), { force: true });
      this.boards.delete(slug);
      this.commit({ t: "board.delta", rev: this.revision + 1, removed: slug });
    });
  }

  private async write(draft: Board): Promise<Board> {
    const board = parse(Board, { ...draft, updatedAt: new Date().toISOString() });
    const path = join(this.dir, `${board.slug}.json`);
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(board, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, path);
    this.boards.set(board.slug, board);
    this.commit({ t: "board.delta", rev: this.revision + 1, board });
    return board;
  }

  private commit(delta: BoardDelta): void {
    this.revision = delta.rev;
    this.onChange?.(delta);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
