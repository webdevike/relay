import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillUsageIndex, USAGE_REFRESH_MS } from "../src/skills/usage";

const dirs: string[] = [];
const DAY = 24 * 60 * 60_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const read = (at: number, ...paths: string[]): string =>
  `${JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { content: paths.map((path) => ({ type: "toolCall", name: "read", arguments: { path } })) } })}\n`;

function home(): { home: string; write: (path: string, text: string, mtime?: number) => string } {
  const root = mkdtempSync(join(tmpdir(), "relay-skills-usage-"));
  dirs.push(root);
  return {
    home: root,
    write: (path, text, mtime) => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
      if (mtime !== undefined) utimesSync(full, mtime / 1000, mtime / 1000);
      return full;
    },
  };
}

describe("SkillUsageIndex", () => {
  it("counts skill:// reads of the last 30 days per skill, with the newest time and its profile", async () => {
    const now = Date.now();
    const { home: root, write } = home();
    write(
      ".omp/profiles/personal/agent/sessions/-Eva/2026_a.jsonl",
      read(now - 3 * DAY, "skill://canvas") +
        read(now - 2 * DAY, "skill://canvas/refs/notes.md", "skill://work") +
        read(now - 40 * DAY, "skill://canvas") +
        // An agent quoting the JSON is not a read.
        `${JSON.stringify({ type: "message", timestamp: new Date(now).toISOString(), text: '"path":"skill://canvas"' })}\n`,
    );
    write(".omp/agent/sessions/x/y/b.jsonl", read(now - DAY, "skill://work"));
    // Untouched for 40 days: not read at all.
    write(".omp/profiles/work/agent/sessions/old.jsonl", read(now - DAY, "skill://canvas"), now - 40 * DAY);
    // A line longer than a read chunk, then a load: the line carries across chunks.
    write(".omp/profiles/work/agent/sessions/big.jsonl", `${JSON.stringify({ pad: "x".repeat(1_500_000) })}\n${read(now - 5 * DAY, "skill://isaac-design")}`);
    const index = new SkillUsageIndex({ home: root, now: () => now });
    expect(index.usage("canvas")).toEqual({ loads: 0, lastUsedAt: null, lastProfile: null });
    await index.refresh();
    expect(index.usage("canvas")).toEqual({ loads: 2, lastUsedAt: now - 2 * DAY, lastProfile: "personal" });
    expect(index.usage("work")).toEqual({ loads: 2, lastUsedAt: now - DAY, lastProfile: null });
    expect(index.usage("isaac-design")).toEqual({ loads: 1, lastUsedAt: now - 5 * DAY, lastProfile: "work" });
  });

  it("serves the last snapshot and rescans changed files at most every 10 minutes", async () => {
    let now = Date.now();
    const { home: root, write } = home();
    const file = write(".omp/agent/sessions/a.jsonl", read(now - DAY, "skill://canvas"));
    const index = new SkillUsageIndex({ home: root, now: () => now });
    await index.refresh();
    expect(index.usage("canvas").loads).toBe(1);
    appendFileSync(file, read(now, "skill://canvas"));
    // Not due yet: the old snapshot.
    expect(index.usage("canvas").loads).toBe(1);
    now += USAGE_REFRESH_MS + 1;
    // The next read starts a background scan; it finishes with the new load.
    index.usage("canvas");
    await index.refresh();
    expect(index.usage("canvas")).toMatchObject({ loads: 2, lastUsedAt: now - USAGE_REFRESH_MS - 1 });
  });
});
