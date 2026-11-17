import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "../src/workspace/service";
import { CanvasFilesService } from "../src/canvas/files";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-mirror-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("WorkspaceService", () => {
  const make = (): WorkspaceService =>
    new WorkspaceService({
      path: join(dir, "relay", "workspace.json"),
      log: () => undefined,
      saveDelayMs: 0,
    });

  it("merges per key, last writer wins, and reports only what changed", () => {
    const ws = make();
    expect(
      ws.put({ origin: "mini", set: { tabs: 1, "layout:a": { x: 1 } }, del: [], seed: true }),
    ).toMatchObject({ rev: 1, applied: true });
    // The MacBook's put: one key the same, one changed, one deleted, one deleted that was never there.
    const r = ws.put({
      origin: "book",
      set: { tabs: 1, "layout:a": { x: 2 } },
      del: ["page:t1", "order"],
    });
    expect(r).toEqual({
      rev: 2,
      applied: true,
      changed: {
        t: "workspace.changed",
        rev: 2,
        origin: "book",
        set: { "layout:a": { x: 2 } },
        del: [],
      },
    });
    expect(ws.put({ origin: "book", set: { tabs: 1 }, del: [] })).toEqual({
      rev: 2,
      applied: true,
      changed: null,
    });
    expect(ws.put({ origin: "mini", set: {}, del: ["tabs"] }).changed).toMatchObject({
      rev: 3,
      del: ["tabs"],
    });
    expect(ws.snapshot()).toEqual({ rev: 3, entries: { "layout:a": { x: 2 } } });
  });

  it("refuses a seed once it holds entries, and keeps them across a restart in a 0600 file", () => {
    const ws = make();
    ws.put({ origin: "mini", set: { tabs: 1 }, del: [], seed: true });
    expect(ws.put({ origin: "book", set: { tabs: 9 }, del: [], seed: true })).toEqual({
      rev: 1,
      applied: false,
      changed: null,
    });
    const path = join(dir, "relay", "workspace.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(make().snapshot()).toEqual({ rev: 1, entries: { tabs: 1 } });
    writeFileSync(path, "not json");
    expect(make().snapshot()).toEqual({ rev: 0, entries: {} });
  });
});

describe("CanvasFilesService", () => {
  const boards = (): string => join(dir, "boards");
  const start = async (): Promise<{
    files: CanvasFilesService;
    changes: [string | null, string | null][];
  }> => {
    const files = new CanvasFilesService({ dir: boards(), log: () => undefined, debounceMs: 20 });
    const changes: [string | null, string | null][] = [];
    files.onChange = (slug, origin) => changes.push([slug, origin]);
    await files.start();
    return { files, changes };
  };

  it("writes, reads, lists and removes boards, telling watchers with the writer's origin once", async () => {
    const { files, changes } = await start();
    try {
      expect(
        await files.handle({
          t: "canvas.file.req",
          rid: "1",
          op: "write",
          slug: "plan",
          text: '{"a":1}',
          origin: "book",
        }),
      ).toEqual({ ok: true });
      expect(
        await files.handle({
          t: "canvas.file.req",
          rid: "2",
          op: "write",
          slug: "plan",
          text: '{"a":2}',
          origin: "book",
        }),
      ).toEqual({ ok: true });
      expect(
        await files.handle({ t: "canvas.file.req", rid: "3", op: "read", slug: "plan" }),
      ).toEqual({ ok: true, text: '{"a":2}' });
      expect(
        await files.handle({ t: "canvas.file.req", rid: "4", op: "read", slug: "gone" }),
      ).toEqual({ ok: true, text: null });
      const list = await files.handle({ t: "canvas.file.req", rid: "5", op: "list" });
      expect(list.files?.map((f) => [f.slug, f.text])).toEqual([["plan", '{"a":2}']]);
      expect(
        await files.handle({
          t: "canvas.file.req",
          rid: "6",
          op: "remove",
          slug: "plan",
          origin: "book",
        }),
      ).toEqual({ ok: true });
      // The folder watch sees our own writes too and stays quiet about them: a board added on the
      // host afterwards is the only thing it reports.
      writeFileSync(join(boards(), "other.json"), "{}");
      await vi.waitFor(() =>
        expect(changes).toEqual([
          [null, "book"],
          ["plan", "book"],
          [null, "book"],
          [null, null],
        ]),
      );
    } finally {
      files.stop();
    }
  });

  it("tells watchers about a board changed on the host itself with no origin", async () => {
    mkdirSync(boards(), { recursive: true });
    writeFileSync(join(boards(), "plan.json"), "{}");
    const { files, changes } = await start();
    try {
      writeFileSync(join(boards(), "plan.json"), '{"title":"x"}');
      await vi.waitFor(() => expect(changes).toEqual([["plan", null]]));
    } finally {
      files.stop();
    }
  });

  it("keeps assets inside the boards folder", async () => {
    const { files } = await start();
    try {
      const data = Buffer.from("png-bytes").toString("base64");
      expect(
        await files.handle({
          t: "canvas.file.req",
          rid: "1",
          op: "asset.write",
          src: "assets/plan/a.png",
          data,
        }),
      ).toEqual({ ok: true });
      expect(readFileSync(join(boards(), "assets", "plan", "a.png"), "utf8")).toBe("png-bytes");
      expect(
        await files.handle({
          t: "canvas.file.req",
          rid: "2",
          op: "asset.read",
          src: "assets/plan/a.png",
        }),
      ).toEqual({ ok: true, data });
      for (const src of ["../secret", "/etc/hosts", "assets/../../x"]) {
        expect(
          await files.handle({ t: "canvas.file.req", rid: "3", op: "asset.read", src }),
        ).toMatchObject({ ok: false, code: "invalid" });
      }
      expect(
        await files.handle({
          t: "canvas.file.req",
          rid: "4",
          op: "asset.read",
          src: "assets/none.png",
        }),
      ).toMatchObject({ ok: false, code: "not-found" });
    } finally {
      files.stop();
    }
  });
});
