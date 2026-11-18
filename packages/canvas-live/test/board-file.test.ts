import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoardConflict,
  NO_BOARD,
  STALE_LOCK_MS,
  boardRevision,
  writeBoardFile,
} from "../src/board-file";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function boardPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-file-"));
  dirs.push(dir);
  return path.join(dir, "plan.json");
}

describe("writeBoardFile", () => {
  it("refuses a write made from a revision the file no longer is, and leaves the file alone", async () => {
    const file = boardPath();
    await writeBoardFile(file, "v1", { ifRevision: NO_BOARD });
    const read = fs.readFileSync(file, "utf8");
    await writeBoardFile(file, "v2 by the other Mac");
    await expect(
      writeBoardFile(file, "v2 from v1", { ifRevision: boardRevision(read) }),
    ).rejects.toBeInstanceOf(BoardConflict);
    expect(fs.readFileSync(file, "utf8")).toBe("v2 by the other Mac");
    await expect(writeBoardFile(file, "again", { ifRevision: NO_BOARD })).rejects.toBeInstanceOf(
      BoardConflict,
    );
    expect(fs.readdirSync(path.dirname(file))).toEqual(["plan.json"]);
  });

  it("loses no change when writers read, change and write the same board at once", async () => {
    const file = boardPath();
    await writeBoardFile(file, "0");
    const bump = async (): Promise<void> => {
      for (;;) {
        const text = fs.readFileSync(file, "utf8");
        try {
          await writeBoardFile(file, String(Number(text) + 1), { ifRevision: boardRevision(text) });
          return;
        } catch (error) {
          if (!(error instanceof BoardConflict)) throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: 20 }, bump));
    expect(fs.readFileSync(file, "utf8")).toBe("20");
  });

  it("breaks a lock a writer that died left behind", async () => {
    const file = boardPath();
    fs.writeFileSync(`${file}.lock`, "");
    const old = (Date.now() - STALE_LOCK_MS - 1000) / 1000;
    fs.utimesSync(`${file}.lock`, old, old);
    await writeBoardFile(file, "v1");
    expect(fs.readFileSync(file, "utf8")).toBe("v1");
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("writes nothing when the commit check throws", async () => {
    const file = boardPath();
    await writeBoardFile(file, "v1");
    const refuse = (): void => {
      throw new Error("taken over");
    };
    await expect(writeBoardFile(file, "v2", { commit: refuse })).rejects.toThrow("taken over");
    expect(fs.readFileSync(file, "utf8")).toBe("v1");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["plan.json"]);
  });
});
