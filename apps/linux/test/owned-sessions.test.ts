import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNED_RECENT_MS, ownedSessions } from "../src/agents/owned-sessions";

const NOW = Date.now();
const ID_A = "01a1ac23-3add-73da-b873-3bc15cc1dc5d";
const ID_B = "01a1ac33-03bf-77ba-8bdb-eaf816c4bf08";
const ID_C = "01a1ac44-0000-7000-8000-000000000001";

describe("ownedSessions", () => {
  it("lists an assistant's open, recent sessions from any profile's sessions folder, with title, folder and activity", () => {
    const home = mkdtempSync(join(tmpdir(), "owned-home-"));
    const store = (profile: string): string => join(home, ".omp", "profiles", profile, "agent", "sessions", "-Eva");
    const write = (profile: string, id: string, ageMs: number): string => {
      mkdirSync(store(profile), { recursive: true });
      const file = join(store(profile), `2026-11-05T14-35-52-413Z_${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: "title", title: "" })}\n${JSON.stringify({ type: "session", id, cwd: "/Users/ike/Eva/work/x" })}\n`);
      utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
      return file;
    };
    const work = write("work", ID_A, 30_000);
    const personal = write("personal", ID_B, 60 * 60_000);
    const closed = write("work", ID_C, 1000);
    const stale = write("work", "01a1ac55-0000-7000-8000-000000000002", OWNED_RECENT_MS + 60_000);
    const dir = join(home, "work", "eva", "agents", "astra");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify([
        { id: "a", sessionFile: work, title: "ENG-6867 auto-work", startedAt: new Date(NOW - 600_000).toISOString() },
        { id: "b", sessionFile: personal },
        { id: "c", sessionFile: closed, closedAt: new Date(NOW).toISOString() },
        { id: "d", sessionFile: stale },
        { id: "e", sessionFile: "/etc/passwd" },
        { id: "f", sessionFile: join(home, "gone", "sessions", `x_${ID_A}.jsonl`) },
      ]),
    );
    const found = ownedSessions(home, NOW);
    expect(found.map((s) => s.id)).toEqual([ID_A, ID_B]);
    expect(found[0]).toMatchObject({ owner: "astra", file: work, title: "ENG-6867 auto-work", projectPath: "/Users/ike/Eva/work/x", working: true });
    expect(found[1]).toMatchObject({ file: personal, working: false });
  });

  it("is empty when no assistant keeps a record", () => {
    expect(ownedSessions(mkdtempSync(join(tmpdir(), "owned-none-")), NOW)).toEqual([]);
  });
});
