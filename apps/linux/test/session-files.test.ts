import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SESSION_CHUNK, SessionFiles } from "../src/agents/session-files";

const HASH = "a".repeat(64);
const PNG = Buffer.from("89504e470d0a1a0a0000", "hex");
let root: string;
let files: SessionFiles;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "relay-session-files-"));
  const agent = join(root, "agent");
  const chat = join(agent, "sessions", "-Eva");
  mkdirSync(join(chat, "2026-10-01T00-00-00-000Z_old"), { recursive: true });
  mkdirSync(join(agent, "blobs"), { recursive: true });
  writeFileSync(join(chat, "2026-10-01T00-00-00-000Z_old.jsonl"), "old\n");
  utimesSync(join(chat, "2026-10-01T00-00-00-000Z_old.jsonl"), 1000, 1000);
  writeFileSync(join(chat, "2026-10-02T00-00-00-000Z_new.jsonl"), "0123456789");
  writeFileSync(join(chat, "2026-10-01T00-00-00-000Z_old", "Sub.jsonl"), "subagent\n");
  writeFileSync(join(chat, "notes.txt"), "x");
  writeFileSync(join(root, "secret.jsonl"), "secret");
  symlinkSync(join(root, "secret.jsonl"), join(chat, "link.jsonl"));
  symlinkSync(root, join(agent, "sessions", "escape"));
  writeFileSync(join(agent, "blobs", `${HASH}.png`), PNG);
  files = new SessionFiles(root);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("SessionFiles", () => {
  it("lists top-level .jsonl transcripts newest first with size and mtime", () => {
    const list = files.list();
    expect(list.map((f) => [f.dir, f.name, f.size])).toEqual([
      ["-Eva", "2026-10-02T00-00-00-000Z_new.jsonl", 10],
      ["-Eva", "2026-10-01T00-00-00-000Z_old.jsonl", 4],
    ]);
    expect(list[1]?.mtime).toBe(1_000_000);
  });

  it("reads raw bytes from an offset, bounded by limit and the frame cap", () => {
    const name = "2026-10-02T00-00-00-000Z_new.jsonl";
    expect(files.read(undefined, "-Eva", name, 3, 4)).toEqual({ data: Buffer.from("3456").toString("base64"), size: 10 });
    expect(files.read(undefined, "-Eva", name, 10)).toEqual({ data: "", size: 10 });
    writeFileSync(join(root, "agent", "sessions", "-Eva", name), Buffer.alloc(MAX_SESSION_CHUNK + 10, 1));
    const chunk = files.read(undefined, "-Eva", name, 0, MAX_SESSION_CHUNK * 4);
    expect(Buffer.from(chunk?.data ?? "", "base64").length).toBe(MAX_SESSION_CHUNK);
    expect(chunk?.size).toBe(MAX_SESSION_CHUNK + 10);
  });

  it("refuses traversal, absolute paths, symlinks out and non-transcripts", () => {
    expect(files.read(undefined, "..", "secret.jsonl", 0)).toBeNull();
    expect(files.read(undefined, "-Eva", "../../../secret.jsonl", 0)).toBeNull();
    expect(files.read(undefined, root, "secret.jsonl", 0)).toBeNull();
    expect(files.read(undefined, "-Eva", join(root, "secret.jsonl"), 0)).toBeNull();
    expect(files.read(undefined, "-Eva", "link.jsonl", 0)).toBeNull();
    expect(files.read(undefined, "escape", "secret.jsonl", 0)).toBeNull();
    expect(files.read(undefined, "-Eva", "notes.txt", 0)).toBeNull();
    expect(files.read(undefined, "-Eva/2026-10-01T00-00-00-000Z_old", "Sub.jsonl", 0)).toBeNull();
    expect(files.read("..", "agent", "x.jsonl", 0)).toBeNull();
    expect(files.blob("../secret")).toBeNull();
  });

  it("returns a blob's bytes and mime by hash", () => {
    expect(files.blob(HASH)).toEqual({ mime: "image/png", data: PNG.toString("base64") });
    expect(files.blob("b".repeat(64))).toBeNull();
  });

  it("finds the transcript for an omp session id", () => {
    expect(files.fileForSessionId("new")).toEqual({ path: join(root, "agent", "sessions", "-Eva", "2026-10-02T00-00-00-000Z_new.jsonl") });
    expect(files.fileForSessionId("missing")).toBeNull();
  });

  it("lists, reads and finds transcripts and blobs in named profile stores", () => {
    const work = join(root, "profiles", "work", "agent");
    const name = "2026-10-03T00-00-00-000Z_w1.jsonl";
    mkdirSync(join(work, "sessions", "-Eva"), { recursive: true });
    mkdirSync(join(work, "blobs"));
    writeFileSync(join(work, "sessions", "-Eva", name), "work\n");
    writeFileSync(join(work, "blobs", "c".repeat(64)), PNG);
    mkdirSync(join(root, "profiles", "empty"));
    expect(files.list().map((f) => [f.profile, f.dir, f.name])).toEqual([
      ["work", "-Eva", name],
      [undefined, "-Eva", "2026-10-02T00-00-00-000Z_new.jsonl"],
      [undefined, "-Eva", "2026-10-01T00-00-00-000Z_old.jsonl"],
    ]);
    expect(files.read("work", "-Eva", name, 0)).toEqual({ data: Buffer.from("work\n").toString("base64"), size: 5 });
    expect(files.read(undefined, "-Eva", name, 0)).toBeNull();
    expect(files.read("empty", "-Eva", name, 0)).toBeNull();
    expect(files.fileForSessionId("w1")).toEqual({ profile: "work", path: join(work, "sessions", "-Eva", name) });
    expect(files.blob("c".repeat(64))).toEqual({ mime: "image/png", data: PNG.toString("base64") });
  });
});
