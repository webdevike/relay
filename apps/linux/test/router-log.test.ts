import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@relay/protocol";
import { RouterLog, withRouter } from "../src/assistant/router-log";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const decision = {
  v: 1,
  kind: "decision",
  id: "sr-1",
  at: "2026-11-17T20:00:00.000Z",
  assistant: "nova",
  mode: "shadow",
  agent: "diagram",
  confidence: 0.91,
  why: "asks for a flow chart",
  alternatives: [{ agent: "diagram", p: 0.91 }],
  threshold: 0.7,
  hinted: false,
  latencyMs: 280,
  prompt: "draw",
};
const line = (entry: unknown): string => `${JSON.stringify(entry)}\n`;
const routerEntry = (data: unknown) => ({ type: "custom", id: "c", customType: "eva.specialist-router", data });
const userEntry = (id: string, timestamp: number) => ({
  type: "message",
  id,
  message: { role: "user", content: "draw it", timestamp },
});

describe("RouterLog", () => {
  it("reads only what was appended, waits for a line to finish, and refolds when an outcome lands", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-log-"));
    dirs.push(dir);
    const file = join(dir, "t.jsonl");
    const log = new RouterLog();
    writeFileSync(file, line(routerEntry(decision)) + line({ type: "custom", customType: "date" }));
    expect(log.turns(file).size).toBe(0);
    // A user line still being written: nothing yet.
    const user = line(userEntry("e1", 42));
    writeFileSync(file, user.slice(0, 20), { flag: "a" });
    expect(log.turns(file).size).toBe(0);
    writeFileSync(file, user.slice(20), { flag: "a" });
    expect(log.turns(file).get(42)?.decision.agent).toBe("diagram");
    expect(log.turns(file).get(42)?.outcome).toBeUndefined();
    writeFileSync(
      file,
      line(routerEntry({ v: 1, kind: "outcome", id: "sr-1", at: "x", used: false, usedAgents: [], skipReason: "wanted words" })),
      { flag: "a" },
    );
    expect(log.turns(file).get(42)?.outcome?.skipReason).toBe("wanted words");
    // A file rewritten shorter is read again from the top.
    writeFileSync(file, line(userEntry("e9", 7)));
    expect(log.turns(file).size).toBe(0);
    expect(log.turns(join(dir, "missing.jsonl")).size).toBe(0);
  });
});

describe("withRouter", () => {
  it("puts a turn on Isaac's row with the same timestamp, and on nothing else", () => {
    const rows: AssistantMessage[] = [
      { id: "u1", role: "user", text: "draw it", at: 42 },
      { id: "s1", role: "status", text: "job", at: 42 },
      { id: "u2", role: "user", text: "thanks", at: 43 },
    ];
    const turn = { decision: { ...decision, kind: "decision" as const, v: 1 as const, mode: "shadow" as const } };
    const out = withRouter(rows, new Map([[42, turn]]));
    expect(out.map((row) => row.router?.decision.id)).toEqual(["sr-1", undefined, undefined]);
    expect(out[2]).toBe(rows[2]);
  });
});
