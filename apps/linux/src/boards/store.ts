// Live dashboards on disk: `<dir>/<slug>.json`, one pretty-printed `Board` per file. Files are read
// once at start (invalid ones are logged and skipped); afterwards memory is authoritative. Every
// write runs through one async queue: render the tiles written as live OpenUI (checked, then
// evaluated against real query data into the static `spec` older clients draw), check the tiles
// written as Mantine JSX (their `spec` is the older clients' fallback), validate the whole
// result, persist it (tmp + rename), then commit it in memory, bump the global rev and report the
// change. A write that fails changes nothing, so a batch of ops lands all together or not at all.
// A board's tiles sit in its own `widgets` list or, once it has tabs, in one list per tab.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Board,
  BoardOp,
  BoardPut,
  type BoardWidgetInput,
  type ServerMessage,
  type WidgetSpec,
} from "@relay/protocol";
import { mantineSourceRefusal } from "../../../../packages/widget-runtime/src/check";
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
  return error.issues
    .map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    )
    .join("; ");
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BoardError(400, issues(result.error));
  return result.data;
}

/** A tab being written: its tiles as written. */
interface TabDraft {
  id: string;
  title: string;
  widgets: BoardWidgetInput[];
}

/** A board being written: tiles given as a live `openui` source have no `spec` until rendered. */
type BoardDraft = Omit<Board, "widgets" | "tabs"> & {
  widgets: BoardWidgetInput[];
  tabs?: TabDraft[];
};

/** Checks a live source and renders it against real query data into its static `spec`; throws why not. */
export type LiveRender = (source: string) => Promise<WidgetSpec>;

/** What a client without Mantine tiles draws for one written without a `spec`. */
export const MANTINE_FALLBACK: WidgetSpec = {
  widget: "text",
  text: "This tile needs a newer Relay to show.",
  style: "muted",
};

/**
 * A tile as written: an `openui` source drops any `spec` beside it (the host renders its own); a
 * `mantine` source must compile and keeps a `spec` beside it as its fallback (else MANTINE_FALLBACK).
 */
function inputWidget(widget: BoardWidgetInput): BoardWidgetInput {
  if (widget.mantine !== undefined) {
    if (widget.openui !== undefined)
      throw new BoardError(400, `widget ${widget.id} has both openui and mantine; give one`);
    const refusal = mantineSourceRefusal(widget.mantine);
    if (refusal !== null) throw new BoardError(400, `widget ${widget.id} mantine: ${refusal}`);
    return {
      id: widget.id,
      span: widget.span,
      spec: widget.spec ?? MANTINE_FALLBACK,
      mantine: widget.mantine,
      ...(widget.height === undefined ? {} : { height: widget.height }),
    };
  }
  if (widget.height !== undefined)
    throw new BoardError(400, `widget ${widget.id}: height is for mantine tiles`);
  if (widget.openui !== undefined)
    return { id: widget.id, span: widget.span, openui: widget.openui };
  if (widget.spec === undefined)
    throw new BoardError(400, `widget ${widget.id} needs a spec, an openui source or mantine JSX`);
  return { id: widget.id, span: widget.span, spec: widget.spec };
}

/** The list holding tile `id`: the board's own, or the tab's that has it. */
function listOf(draft: BoardDraft, id: string): BoardWidgetInput[] | undefined {
  if (draft.widgets.some((widget) => widget.id === id)) return draft.widgets;
  return draft.tabs?.find((tab) => tab.widgets.some((widget) => widget.id === id))?.widgets;
}

/** Adds, renames or moves a tab; the board's first tab takes the board's tiles. */
function applyTab(draft: BoardDraft, op: Extract<BoardOp, { op: "tab" }>): BoardDraft {
  const tabs = draft.tabs ?? [];
  const current = tabs.find((tab) => tab.id === op.id);
  const at = current === undefined ? -1 : tabs.indexOf(current);
  const first = tabs.length === 0;
  let tab: TabDraft;
  if (current !== undefined) {
    tab = { ...current, title: op.title ?? current.title };
  } else {
    if (op.title === undefined) throw new BoardError(400, `new tab ${op.id} needs a title`);
    tab = { id: op.id, title: op.title, widgets: first ? draft.widgets : [] };
  }
  const rest = tabs.filter((other) => other.id !== op.id);
  if (op.after === undefined) {
    if (at >= 0) rest.splice(at, 0, tab);
    else rest.push(tab);
  } else if (op.after === null) rest.unshift(tab);
  else {
    if (op.after === op.id) throw new BoardError(400, `tab ${op.id} cannot go after itself`);
    const anchor = rest.findIndex((other) => other.id === op.after);
    if (anchor < 0) throw new BoardError(400, `no tab ${op.after} to place ${op.id} after`);
    rest.splice(anchor + 1, 0, tab);
  }
  return { ...draft, widgets: first ? [] : draft.widgets, tabs: rest };
}

/** Applies `ops` in order to a copy of `board`; throws on an op that cannot apply. */
export function applyOps(board: Board, ops: readonly BoardOp[]): BoardDraft {
  const { tabs: boardTabs, ...fields } = board;
  let next: BoardDraft = {
    ...fields,
    widgets: [...board.widgets],
    ...(boardTabs === undefined
      ? {}
      : { tabs: boardTabs.map((tab) => ({ ...tab, widgets: [...tab.widgets] })) }),
  };
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
    if (op.op === "tab") {
      next = applyTab(next, op);
      continue;
    }
    if (op.op === "remove-tab") {
      const remaining = (next.tabs ?? []).filter((tab) => tab.id !== op.id);
      if (remaining.length === (next.tabs ?? []).length)
        throw new BoardError(400, `no tab ${op.id}`);
      if (remaining.length > 0) next = { ...next, tabs: remaining };
      else delete next.tabs;
      continue;
    }
    const from = listOf(next, op.id);
    const at = from?.findIndex((widget) => widget.id === op.id) ?? -1;
    if (op.op === "remove") {
      if (from !== undefined) from.splice(at, 1);
      continue;
    }
    let to: BoardWidgetInput[];
    if (op.tab !== undefined) {
      const tab = next.tabs?.find((candidate) => candidate.id === op.tab);
      if (tab === undefined) throw new BoardError(400, `no tab ${op.tab} for widget ${op.id}`);
      to = tab.widgets;
    } else if (from !== undefined) to = from;
    else if (next.tabs !== undefined)
      throw new BoardError(400, `board ${board.slug} has tabs: give widget ${op.id} a tab`);
    else to = next.widgets;
    const existing = from?.[at];
    const widget = inputWidget({
      id: op.id,
      span: op.span ?? existing?.span ?? 12,
      ...(op.spec === undefined ? {} : { spec: op.spec }),
      ...(op.openui === undefined ? {} : { openui: op.openui }),
      ...(op.mantine === undefined ? {} : { mantine: op.mantine }),
      ...(op.height === undefined ? {} : { height: op.height }),
    });
    if (op.after === undefined && from === to) {
      to[at] = widget;
      continue;
    }
    if (op.after === op.id) throw new BoardError(400, `widget ${op.id} cannot go after itself`);
    if (from !== undefined) from.splice(at, 1);
    if (op.after === undefined) to.push(widget);
    else if (op.after === null) to.unshift(widget);
    else {
      const anchor = to.findIndex((other) => other.id === op.after);
      if (anchor < 0) throw new BoardError(400, `no widget ${op.after} to place ${op.id} after`);
      to.splice(anchor + 1, 0, widget);
    }
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
    /** Renders live tiles; null refuses them ("live widgets need the host's query tools"). */
    private readonly live: LiveRender | null,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort()) {
      const path = join(dir, name);
      try {
        const board = Board.parse(JSON.parse(readFileSync(path, "utf8")));
        if (`${board.slug}.json` !== name)
          throw new Error(`slug ${board.slug} does not match the file name`);
        this.boards.set(board.slug, board);
      } catch (error) {
        log(
          `boards: skipping ${path}: ${error instanceof z.ZodError ? issues(error) : error instanceof Error ? error.message : String(error)}`,
        );
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
        widgets: (put.widgets ?? []).map(inputWidget),
        ...(put.tabs === undefined
          ? {}
          : {
              tabs: put.tabs.map((tab) => ({
                id: tab.id,
                title: tab.title,
                widgets: (tab.widgets ?? []).map(inputWidget),
              })),
            }),
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

  /** Renders the tiles written as `openui` (in parallel), then validates and persists the board. */
  private async write(draft: BoardDraft): Promise<Board> {
    const render = (widgets: readonly BoardWidgetInput[]) =>
      Promise.all(
        widgets.map(async (widget) => {
          if (widget.spec !== undefined) return widget;
          if (widget.openui === undefined)
            throw new BoardError(400, `widget ${widget.id} needs a spec or an openui source`);
          if (this.live === null)
            throw new BoardError(
              400,
              "live widgets need the host's query tools, which this host does not run",
            );
          try {
            return { ...widget, spec: await this.live(widget.openui) };
          } catch (error) {
            throw new BoardError(
              400,
              `widget ${widget.id} openui: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );
    const [widgets, tabs] = await Promise.all([
      render(draft.widgets),
      draft.tabs === undefined
        ? undefined
        : Promise.all(
            draft.tabs.map(async (tab) => ({ ...tab, widgets: await render(tab.widgets) })),
          ),
    ]);
    const board = parse(Board, {
      ...draft,
      widgets,
      ...(tabs === undefined ? {} : { tabs }),
      updatedAt: new Date().toISOString(),
    });
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
