import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, type WidgetSpec } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { handleBoardRequest } from "../src/boards/http";
import { handleShareRequest, SHARE_PAGE_CSP } from "../src/boards/share-page";
import { BoardShares } from "../src/boards/shares";
import {
  BoardError,
  FileBoardStore,
  MANTINE_FALLBACK,
  type BoardDelta,
  type LiveRender,
} from "../src/boards/store";
import { SHARE_DATA_SLOT, SHARE_RUNTIME_SLOT } from "../../../packages/canvas-web/src/share/slots";

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

function store(
  dir = freshDir(),
  log: string[] = [],
): { boards: FileBoardStore; deltas: BoardDelta[]; dir: string; log: string[] } {
  const boards = new FileBoardStore(dir, (line) => log.push(line), null);
  const deltas: BoardDelta[] = [];
  boards.onChange = (delta) => deltas.push(delta);
  return { boards, deltas, dir, log };
}

describe("FileBoardStore", () => {
  it("put creates a board with default span, persists pretty JSON, and bumps rev once per write", async () => {
    const { boards, deltas, dir } = store();
    const board = await boards.put("ops", {
      title: "Ops",
      widgets: [{ id: "a", spec: stat("1") }],
    });
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
    await boards.put("m", {
      title: "M",
      workspace: "relay",
      widgets: [
        { id: "a", spec: stat("1") },
        { id: "b", spec: stat("2") },
      ],
    });
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
    await expect(
      boards.apply("x", [{ op: "upsert", id: "b", spec: stat("2"), after: "nope" }]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      boards.apply("x", [{ op: "upsert", id: "a", spec: stat("2"), after: "a" }]),
    ).rejects.toBeInstanceOf(BoardError);
    expect(boards.rev).toBe(1);
    expect(deltas).toHaveLength(1);
    expect(boards.get("x")?.widgets.map((widget) => widget.id)).toEqual(["a"]);
    expect(readFileSync(join(dir, "x.json"), "utf8")).toBe(before);
  });

  it("rejects duplicate ids, too-deep specs, bad slugs, and ops on a missing board", async () => {
    const { boards } = store();
    await expect(
      boards.put("d", {
        title: "D",
        widgets: [
          { id: "a", spec: stat("1") },
          { id: "a", spec: stat("2") },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });
    let deep: unknown = stat("leaf");
    for (let level = 0; level < 6; level += 1) deep = { widget: "stack", children: [deep] };
    await expect(
      boards.put("d", { title: "D", widgets: [{ id: "a", spec: deep }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(boards.put("../etc", { title: "D" })).rejects.toMatchObject({ status: 400 });
    await expect(boards.apply("ghost", [{ op: "remove", id: "a" }])).rejects.toMatchObject({
      status: 404,
    });
    await expect(boards.remove("ghost")).rejects.toMatchObject({ status: 404 });
    expect(boards.rev).toBe(0);
  });

  it("serializes concurrent writes in call order with consecutive revs", async () => {
    const { boards, deltas } = store();
    await boards.put("q", { title: "Q" });
    await Promise.all(
      ["a", "b", "c", "d"].map((id) => boards.apply("q", [{ op: "upsert", id, spec: stat(id) }])),
    );
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

describe("board tabs", () => {
  const tabIds = (board: Board) =>
    board.tabs?.map((tab) => [tab.id, tab.title, tab.widgets.map((widget) => widget.id)]);

  it("the first tab takes the board's tiles; later tiles go into the tab they name", async () => {
    const { boards, dir } = store();
    await boards.put("p", { title: "P", widgets: [{ id: "a", spec: stat("1") }] });
    let board = await boards.apply("p", [
      { op: "tab", id: "deals", title: "Deals" },
      { op: "tab", id: "wife", title: "Wife" },
      { op: "upsert", id: "w1", spec: stat("w"), tab: "wife" },
    ]);
    expect(board.widgets).toEqual([]);
    expect(tabIds(board)).toEqual([
      ["deals", "Deals", ["a"]],
      ["wife", "Wife", ["w1"]],
    ]);
    expect(Board.parse(JSON.parse(readFileSync(join(dir, "p.json"), "utf8")))).toEqual(board);
    // An existing tile edits in place without a tab; a new one on a tabbed board must name one.
    board = await boards.apply("p", [{ op: "upsert", id: "a", spec: stat("2") }]);
    expect(board.tabs?.[0]?.widgets[0]?.spec).toEqual(stat("2"));
    await expect(boards.apply("p", [{ op: "upsert", id: "new", spec: stat("3") }])).rejects.toThrow(
      /has tabs: give widget new a tab/,
    );
    await expect(
      boards.apply("p", [{ op: "upsert", id: "new", spec: stat("3"), tab: "ghost" }]),
    ).rejects.toThrow(/no tab ghost/);
  });

  it("moves a tile to another tab, renames and reorders tabs, and keeps tile ids unique across tabs", async () => {
    const { boards } = store();
    await boards.put("p", {
      title: "P",
      tabs: [
        {
          id: "one",
          title: "One",
          widgets: [
            { id: "a", spec: stat("a") },
            { id: "b", spec: stat("b") },
          ],
        },
        { id: "two", title: "Two", widgets: [{ id: "c", spec: stat("c") }] },
      ],
    });
    const board = await boards.apply("p", [
      { op: "upsert", id: "a", spec: stat("a"), tab: "two", after: null },
      { op: "tab", id: "two", title: "Second", after: null },
      { op: "tab", id: "three", title: "Three", after: "two" },
    ]);
    expect(tabIds(board)).toEqual([
      ["two", "Second", ["a", "c"]],
      ["three", "Three", []],
      ["one", "One", ["b"]],
    ]);
    await expect(boards.apply("p", [{ op: "tab", id: "four" }])).rejects.toThrow(
      /new tab four needs a title/,
    );
    await expect(
      boards.put("dup", {
        title: "D",
        tabs: [
          { id: "x", title: "X", widgets: [{ id: "a", spec: stat("1") }] },
          { id: "y", title: "Y", widgets: [{ id: "a", spec: stat("2") }] },
        ],
      }),
    ).rejects.toThrow(/duplicate widget id a/);
    await expect(
      boards.put("mix", {
        title: "M",
        widgets: [{ id: "a", spec: stat("1") }],
        tabs: [{ id: "x", title: "X" }],
      }),
    ).rejects.toThrow(/keeps its tiles in its tabs/);
  });

  it("remove-tab drops the tab with its tiles; without tabs left the board has no tabs key", async () => {
    const { boards, dir } = store();
    await boards.put("p", {
      title: "P",
      tabs: [
        { id: "one", title: "One", widgets: [{ id: "a", spec: stat("a") }] },
        { id: "two", title: "Two" },
      ],
    });
    let board = await boards.apply("p", [{ op: "remove-tab", id: "one" }]);
    expect(tabIds(board)).toEqual([["two", "Two", []]]);
    board = await boards.apply("p", [{ op: "remove-tab", id: "two" }]);
    expect(board).not.toHaveProperty("tabs");
    expect(readFileSync(join(dir, "p.json"), "utf8")).not.toContain('"tabs"');
    board = await boards.apply("p", [{ op: "upsert", id: "b", spec: stat("b") }]);
    expect(ids(board)).toEqual(["b"]);
    await expect(boards.apply("p", [{ op: "remove-tab", id: "two" }])).rejects.toThrow(
      /no tab two/,
    );
  });
});

describe("board shares", () => {
  const PAGE = `<head>${SHARE_RUNTIME_SLOT}</head><script id="relay-share" type="application/json">${SHARE_DATA_SLOT}</script>`;

  async function shared() {
    const { boards, dir } = store();
    await boards.put("lists", {
      title: "Lists",
      tabs: [
        {
          id: "wife",
          title: "Wife",
          widgets: [{ id: "tumbler", spec: { widget: "text", text: "Lilac tumbler" } }],
        },
        {
          id: "kids",
          title: "Kids",
          widgets: [{ id: "lego", spec: { widget: "text", text: "Lego castle" } }],
        },
      ],
    });
    const shares = new BoardShares(
      join(dir, "shares", "board-shares.json"),
      boards,
      () => undefined,
    );
    const open = async (
      token: string,
      live: ((source: string) => Promise<never>) | null = null,
    ) => {
      const response = await handleShareRequest(
        { shares, boards, live, page: () => PAGE },
        new Request(`http://127.0.0.1/share/${token}`),
        `/share/${token}`,
      );
      return {
        status: response.status,
        csp: response.headers.get("content-security-policy"),
        referrer: response.headers.get("referrer-policy"),
        html: await response.text(),
      };
    };
    return { boards, shares, open, dir };
  }

  it("a tab's link shows that tab alone: never a sibling tab's title or tiles", async () => {
    const { shares, open } = await shared();
    const share = shares.create("lists", "wife");
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const page = await open(share.token);
    expect(page.status).toBe(200);
    expect(page.html).toContain("Lilac tumbler");
    expect(page.html).not.toContain("Lego castle");
    expect(page.html).not.toContain('"Kids"');
    expect(page.html).not.toContain(SHARE_DATA_SLOT);
    expect(page.csp).toBe(SHARE_PAGE_CSP);
    expect(page.csp).toContain("sandbox allow-scripts");
    expect(page.referrer).toBe("no-referrer");
    // The whole board's link brings every tab.
    const whole = await open(shares.create("lists", undefined).token);
    expect(whole.html).toContain("Lilac tumbler");
    expect(whole.html).toContain("Lego castle");
  });

  it("an unknown, revoked or orphaned token shows nothing; shares persist across a restart", async () => {
    const { boards, shares, open, dir } = await shared();
    const share = shares.create("lists", "wife");
    expect((await open("x".repeat(43))).status).toBe(404);
    expect((await open(`${share.token}/extra`)).status).toBe(404);
    const reloaded = new BoardShares(
      join(dir, "shares", "board-shares.json"),
      boards,
      () => undefined,
    );
    expect(reloaded.resolve(share.token)).toEqual(share);
    await boards.apply("lists", [{ op: "remove-tab", id: "wife" }]);
    const gone = await open(share.token);
    expect(gone.status).toBe(404);
    expect(gone.html).not.toContain("Lego castle");
    expect(shares.revoke("other", share.token)).toBe(false);
    expect(shares.revoke("lists", share.token)).toBe(true);
    expect(shares.resolve(share.token)).toBeNull();
    expect(() => shares.create("lists", "wife")).toThrow(/has no tab wife/);
    expect(() => shares.create("ghost", undefined)).toThrow(/no board ghost/);
  });

  it("draws a live tile with data from the load, and its stored spec when that fails", async () => {
    const spec = (value: string): WidgetSpec => ({ widget: "stat", label: "L", value });
    const dir = freshDir();
    const boards = new FileBoardStore(
      dir,
      () => undefined,
      () => Promise.resolve(spec("at write")),
    );
    await boards.put("live", {
      title: "Live",
      widgets: [{ id: "count", openui: 'root = Stat("L", "x")' }],
    });
    const shares = new BoardShares(join(dir, "board-shares.json"), boards, () => undefined);
    const token = shares.create("live", undefined).token;
    const load = async (live: LiveRender) =>
      (
        await handleShareRequest(
          { shares, boards, live, page: () => PAGE },
          new Request(`http://127.0.0.1/share/${token}`),
          `/share/${token}`,
        )
      ).text();
    const fresh = await load(() => Promise.resolve(spec("now")));
    expect(fresh).toContain('"value":"now"');
    expect(fresh).not.toContain("openui");
    expect(await load(() => Promise.reject(new Error("down")))).toContain('"value":"at write"');
  });
});

describe("Mantine tiles", () => {
  const JSX =
    '<AspectRatio ratio={4 / 3}><Image src="data:image/png;base64,AA==" fit="cover" /></AspectRatio>';

  it("store their JSX and height with a fallback spec older clients draw, keeping a writer's spec", async () => {
    const { boards, dir } = store();
    await boards.put("deals", {
      title: "Deals",
      widgets: [{ id: "a", span: 4, mantine: JSX, height: 320 }],
    });
    const board = await boards.apply("deals", [
      { op: "upsert", id: "b", mantine: JSX, spec: stat("9") },
    ]);
    expect(board.widgets).toEqual([
      { id: "a", span: 4, spec: MANTINE_FALLBACK, mantine: JSX, height: 320 },
      { id: "b", span: 12, spec: stat("9"), mantine: JSX },
    ]);
    expect(Board.parse(JSON.parse(readFileSync(join(dir, "deals.json"), "utf8")))).toEqual(board);
    // An older client's schema has no `mantine`: zod drops it and the tile draws its spec.
    const older = z.object({
      widgets: z.array(z.object({ id: z.string(), span: z.number(), spec: z.unknown() })),
    });
    expect(older.parse(board).widgets[0]).toEqual({ id: "a", span: 4, spec: MANTINE_FALLBACK });
  });

  it("refuse JSX that does not compile or names an unknown component, openui beside it, and height without it", async () => {
    const { boards } = store();
    await boards.put("deals", { title: "Deals" });
    const refused = (op: object) => boards.apply("deals", [{ op: "upsert", id: "a", ...op }]);
    await expect(refused({ mantine: "<Card>" })).rejects.toThrow(
      /widget a mantine: does not compile/,
    );
    await expect(refused({ mantine: "<DealCard />" })).rejects.toThrow(
      /unknown component <DealCard>/,
    );
    await expect(refused({ mantine: JSX, openui: 'root = Text("x")' })).rejects.toThrow(
      /both openui and mantine/,
    );
    await expect(refused({ spec: stat("1"), height: 200 })).rejects.toThrow(
      /height is for mantine tiles/,
    );
    await expect(refused({ mantine: JSX, height: 20 })).rejects.toBeInstanceOf(BoardError);
    expect(boards.get("deals")?.widgets).toEqual([]);
  });
});

describe("board HTTP", () => {
  const call = (
    boards: FileBoardStore | null,
    method: string,
    path: string,
    body?: unknown,
    remote = "127.0.0.1",
    headers: Record<string, string> = method === "GET"
      ? {}
      : { "content-type": "application/json" },
  ) =>
    handleBoardRequest(
      boards,
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
      path,
      remote,
    );

  it("serves create, ops, get, list and delete with rev on every reply", async () => {
    const { boards } = store();
    expect(await (await call(boards, "PUT", "/boards/h", { title: "H" })).json()).toMatchObject({
      rev: 1,
      board: { slug: "h" },
    });
    const ops = await call(boards, "POST", "/boards/h/ops", [
      { op: "upsert", id: "a", spec: stat("1") },
    ]);
    expect(await ops.json()).toMatchObject({ rev: 2, board: { widgets: [{ id: "a" }] } });
    expect(await (await call(boards, "GET", "/boards/h")).json()).toMatchObject({
      rev: 2,
      board: { slug: "h" },
    });
    expect(await (await call(boards, "GET", "/boards")).json()).toMatchObject({
      rev: 2,
      boards: [{ slug: "h" }],
    });
    expect(await (await call(boards, "DELETE", "/boards/h")).json()).toEqual({ rev: 3 });
    expect((await call(boards, "GET", "/boards/h")).status).toBe(404);
  });

  it("answers 400 with the zod issue for an invalid spec or non-JSON body, 404 for a missing board, 403 off loopback", async () => {
    const { boards } = store();
    await call(boards, "PUT", "/boards/h", { title: "H" });
    const bad = await call(boards, "POST", "/boards/h/ops", [
      { op: "upsert", id: "a", spec: { widget: "stat", label: "L" } },
    ]);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/"error":"[^"]*0\.spec\.value: Required/);
    expect((await call(boards, "PUT", "/boards/h", "{nope")).status).toBe(400);
    expect(
      (await call(boards, "POST", "/boards/ghost/ops", [{ op: "remove", id: "a" }])).status,
    ).toBe(404);
    expect((await call(boards, "GET", "/boards", undefined, "192.168.1.5")).status).toBe(403);
    expect((await call(null, "GET", "/boards")).status).toBe(404);
    expect(boards.rev).toBe(1);
  });

  it("rejects writes a browser page could send: 415 without a JSON content-type, 403 with an Origin", async () => {
    const { boards } = store();
    await call(boards, "PUT", "/boards/h", { title: "H" });
    const ops = [{ op: "upsert", id: "a", spec: stat("1") }];
    expect(
      (
        await call(boards, "POST", "/boards/h/ops", ops, "127.0.0.1", {
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect((await call(boards, "POST", "/boards/h/ops", ops, "127.0.0.1", {})).status).toBe(415);
    expect((await call(boards, "DELETE", "/boards/h", undefined, "127.0.0.1", {})).status).toBe(
      415,
    );
    const origin = { "content-type": "application/json", origin: "https://evil.example" };
    expect((await call(boards, "POST", "/boards/h/ops", ops, "127.0.0.1", origin)).status).toBe(
      403,
    );
    expect(
      (await call(boards, "PUT", "/boards/h", { title: "X" }, "127.0.0.1", origin)).status,
    ).toBe(403);
    expect(
      (
        await call(boards, "GET", "/boards/h", undefined, "127.0.0.1", {
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(boards, "PUT", "/boards/h", { title: "H2" }, "127.0.0.1", {
          "content-type": "application/json; charset=utf-8",
        })
      ).status,
    ).toBe(200);
    expect(boards.rev).toBe(2);
  });
});
