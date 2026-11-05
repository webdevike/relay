import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_BOOKMARKS, type ServerMessage } from "@relay/protocol";
import { BookmarkService } from "../src/bookmarks/service";

let dir: string;
let sent: ServerMessage[];
const make = (path = join(dir, "bookmarks.json")): BookmarkService =>
  new BookmarkService({ path, broadcast: (m) => void sent.push(m), log: () => undefined });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-bookmarks-"));
  sent = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("BookmarkService", () => {
  it("marks and clears a turn, broadcasting the thread's set each time and nothing on a no-op", () => {
    const service = make();
    expect(service.snapshot("assistant:nova")).toEqual([]);
    expect(service.set("assistant:nova", "user@1", true)).toBe(true);
    expect(service.set("assistant:nova", "assistant@2", true)).toBe(true);
    expect(service.set("assistant:nova", "user@1", true)).toBe(false);
    expect(service.set("assistant:nova", "user@9", false)).toBe(false);
    expect(service.set("session:s1", "user@1", true)).toBe(true);
    expect(service.set("assistant:nova", "user@1", false)).toBe(true);
    expect(service.snapshot("assistant:nova")).toEqual(["assistant@2"]);
    expect(service.snapshot("session:s1")).toEqual(["user@1"]);
    expect(sent).toEqual([
      { t: "bookmarks.snapshot", thread: "assistant:nova", messages: ["user@1"] },
      { t: "bookmarks.snapshot", thread: "assistant:nova", messages: ["user@1", "assistant@2"] },
      { t: "bookmarks.snapshot", thread: "session:s1", messages: ["user@1"] },
      { t: "bookmarks.snapshot", thread: "assistant:nova", messages: ["assistant@2"] },
    ]);
  });

  it("refuses anything that is not a reaction key", () => {
    const service = make();
    expect(service.set("assistant:nova", "u1", true)).toBe(false);
    expect(service.set("assistant:nova", "user@x", true)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("persists privately and comes back after a restart; an emptied thread leaves the file", () => {
    const path = join(dir, "sub", "bookmarks.json");
    const first = make(path);
    first.set("assistant:nova", "user@1", true);
    first.set("session:s1", "assistant@4", true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = make(path);
    expect(again.snapshot("assistant:nova")).toEqual(["user@1"]);
    again.set("assistant:nova", "user@1", false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      threads: { "session:s1": ["assistant@4"] },
    });
  });

  it("starts empty from an unreadable or foreign file", () => {
    const path = join(dir, "bookmarks.json");
    writeFileSync(path, "{nope");
    expect(make(path).snapshot("assistant:nova")).toEqual([]);
    writeFileSync(path, JSON.stringify({ threads: { "assistant:nova": ["bad"] } }));
    expect(make(path).snapshot("assistant:nova")).toEqual([]);
  });

  it("keeps the newest MAX_BOOKMARKS of a thread", () => {
    const service = make();
    for (let i = 0; i < MAX_BOOKMARKS + 2; i++)
      service.set("session:s", `user@${i}`, true);
    const keys = service.snapshot("session:s");
    expect(keys).toHaveLength(MAX_BOOKMARKS);
    expect(keys[0]).toBe("user@2");
  });
});
