import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { handleBoardRequest } from "../src/boards/http";
import { BoardError, FileBoardStore, type BoardDelta } from "../src/boards/store";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-boards-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const stat = (value: string) => ({ widget: "stat", label: "L", value });
const ids = (board: Board): string[] => board.widgets.map((widget) => widget.id);

function store(dir = freshDir(), log: string[] = []): { boards: FileBoardStore; deltas: BoardDelta[]; dir: string; log: string[] } {
  const boards = new FileBoardStore(dir, (line) => log.push(line));
  const deltas: BoardDelta[] = [];
  boards.onChange = (delta) => deltas.push(delta);
  return { boards, deltas, dir, log };
}

describe("FileBoardStore", () => {
  it("put creates a board with default span, persists pretty JSON, and bumps rev once per write", async () => {
    const { boards, deltas, dir } = store();
    const board = await boards.put("ops", { title: "Ops", widgets: [{ id: "a", spec: stat("1") }] });
    expect(board.widgets).toEqual([{ id: "a", span: 12, spec: stat("1") }]);
    expect(boards.rev).toBe(1);
    expect(deltas).toEqual([{ t: "board.delta", rev: 1, board }]);
    const disk = readFileSync(join(dir, "ops.json"), "utf8");
    expect(disk).toContain('\n  "slug": "ops"');
    expect(Board.parse(JSON.parse(disk))).toEqual(board);
    expect(readdirSync(dir)).toEqual(["ops.json"]);
    await boards.put("ops", { title: "Ops 2" });
    expect(boards.rev).toBe(2);
    expect(boards.get("ops")?.widgets).toEqual([]);
  });

  it("upsert appends new tiles, replaces in place when after is absent, and moves with after", async () => {
    const { boards } = store();
    await boards.put("b", { title: "B" });
    let board = await boards.apply("b", [
      { op: "upsert", id: "a", spec: stat("a") },
      { op: "upsert", id: "b", spec: stat("b"), span: 6 },
      { op: "upsert", id: "c", spec: stat("c") },
    ]);
    expect(ids(board)).toEqual(["a", "b", "c"]);
    // Replace in place keeps position and the existing span.
    board = await boards.apply("b", [{ op: "upsert", id: "b", spec: stat("b2") }]);
    expect(ids(board)).toEqual(["a", "b", "c"]);
    expect(board.widgets[1]).toEqual({ id: "b", span: 6, spec: stat("b2") });
    // after: null moves to the front; after: id moves behind it; new tiles insert there too.
    board = await boards.apply("b", [
      { op: "upsert", id: "c", spec: stat("c"), after: null },
      { op: "upsert", id: "a", spec: stat("a"), after: "b" },
      { op: "upsert", id: "d", spec: stat("d"), after: "c" },
    ]);
    expect(ids(board)).toEqual(["c", "d", "b", "a"]);
  });

  it("remove drops a tile and meta updates only the given fields", async () => {
    const { boards } = store();
    await boards.put("m", { title: "M", workspace: "relay", widgets: [{ id: "a", spec: stat("1") }, { id: "b", spec: stat("2") }] });
    const board = await boards.apply("m", [
      { op: "remove", id: "a" },
      { op: "meta", title: "Renamed", icon: "gauge" },
    ]);
    expect(ids(board)).toEqual(["b"]);
    expect(board).toMatchObject({ title: "Renamed", workspace: "relay", icon: "gauge" });
  });

  it("a batch with one bad spec or a missing anchor changes nothing: no rev, no delta, no disk write", async () => {
    const { boards, deltas, dir } = store();
    await boards.put("x", { title: "X", widgets: [{ id: "a", spec: stat("1") }] });
    const before = readFileSync(join(dir, "x.json"), "utf8");
    await expect(
      boards.apply("x", [
        { op: "upsert", id: "b", spec: stat("2") },
        { op: "upsert", id: "c", spec: { widget: "chart", kind: "pie", series: [] } },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(boards.apply("x", [{ op: "upsert", id: "b", spec: stat("2"), after: "nope" }])).rejects.toMatchObject({ status: 400 });
    await expect(boards.apply("x", [{ op: "upsert", id: "a", spec: stat("2"), after: "a" }])).rejects.toBeInstanceOf(BoardError);
    expect(boards.rev).toBe(1);
    expect(deltas).toHaveLength(1);
    expect(boards.get("x")?.widgets.map((widget) => widget.id)).toEqual(["a"]);
    expect(readFileSync(join(dir, "x.json"), "utf8")).toBe(before);
  });

  it("rejects duplicate ids, too-deep specs, bad slugs, and ops on a missing board", async () => {
    const { boards } = store();
    await expect(boards.put("d", { title: "D", widgets: [{ id: "a", spec: stat("1") }, { id: "a", spec: stat("2") }] })).rejects.toMatchObject({ status: 400 });
    let deep: unknown = stat("leaf");
    for (let level = 0; level < 6; level += 1) deep = { widget: "stack", children: [deep] };
    await expect(boards.put("d", { title: "D", widgets: [{ id: "a", spec: deep }] })).rejects.toMatchObject({ status: 400 });
    await expect(boards.put("../etc", { title: "D" })).rejects.toMatchObject({ status: 400 });
    await expect(boards.apply("ghost", [{ op: "remove", id: "a" }])).rejects.toMatchObject({ status: 404 });
    await expect(boards.remove("ghost")).rejects.toMatchObject({ status: 404 });
    expect(boards.rev).toBe(0);
  });

  it("serializes concurrent writes in call order with consecutive revs", async () => {
    const { boards, deltas } = store();
    await boards.put("q", { title: "Q" });
    await Promise.all(["a", "b", "c", "d"].map((id) => boards.apply("q", [{ op: "upsert", id, spec: stat(id) }])));
    expect(boards.get("q")?.widgets.map((widget) => widget.id)).toEqual(["a", "b", "c", "d"]);
    expect(deltas.map((delta) => delta.rev)).toEqual([1, 2, 3, 4, 5]);
  });

  it("delete removes the file and reports removed; a restart reloads boards and skips invalid files", async () => {
    const { boards, deltas, dir } = store();
    await boards.put("keep", { title: "Keep" });
    await boards.put("gone", { title: "Gone" });
    await boards.remove("gone");
    expect(deltas.at(-1)).toEqual({ t: "board.delta", rev: 3, removed: "gone" });
    expect(existsSync(join(dir, "gone.json"))).toBe(false);
    writeFileSync(join(dir, "broken.json"), "{");
    writeFileSync(join(dir, "wrong.json"), readFileSync(join(dir, "keep.json")));
    const reloaded = store(dir);
    expect(reloaded.boards.list().map((board) => board.slug)).toEqual(["keep"]);
    expect(reloaded.log).toHaveLength(2);
  });
});

describe("board HTTP", () => {
  const call = (boards: FileBoardStore | null, method: string, path: string, body?: unknown, remote = "127.0.0.1") =>
    handleBoardRequest(
      boards,
      new Request(`http://127.0.0.1${path}`, body === undefined ? { method } : { method, body: typeof body === "string" ? body : JSON.stringify(body) }),
      path,
      remote,
    );

  it("serves create, ops, get, list and delete with rev on every reply", async () => {
    const { boards } = store();
    expect(await (await call(boards, "PUT", "/boards/h", { title: "H" })).json()).toMatchObject({ rev: 1, board: { slug: "h" } });
    const ops = await call(boards, "POST", "/boards/h/ops", [{ op: "upsert", id: "a", spec: stat("1") }]);
    expect(await ops.json()).toMatchObject({ rev: 2, board: { widgets: [{ id: "a" }] } });
    expect(await (await call(boards, "GET", "/boards/h")).json()).toMatchObject({ rev: 2, board: { slug: "h" } });
    expect(await (await call(boards, "GET", "/boards")).json()).toMatchObject({ rev: 2, boards: [{ slug: "h" }] });
    expect(await (await call(boards, "DELETE", "/boards/h")).json()).toEqual({ rev: 3 });
    expect((await call(boards, "GET", "/boards/h")).status).toBe(404);
  });

  it("answers 400 with the zod issue for an invalid spec or non-JSON body, 404 for a missing board, 403 off loopback", async () => {
    const { boards } = store();
    await call(boards, "PUT", "/boards/h", { title: "H" });
    const bad = await call(boards, "POST", "/boards/h/ops", [{ op: "upsert", id: "a", spec: { widget: "stat", label: "L" } }]);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/"error":"[^"]*0\.spec\.value: Required/);
    expect((await call(boards, "PUT", "/boards/h", "{nope")).status).toBe(400);
    expect((await call(boards, "POST", "/boards/ghost/ops", [{ op: "remove", id: "a" }])).status).toBe(404);
    expect((await call(boards, "GET", "/boards", undefined, "192.168.1.5")).status).toBe(403);
    expect((await call(null, "GET", "/boards")).status).toBe(404);
    expect(boards.rev).toBe(1);
  });
});
