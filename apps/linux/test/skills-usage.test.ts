import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillUsageIndex, skillOfPath, TREND_DAYS, USAGE_REFRESH_MS, type UsageDeps } from "../src/skills/usage";
import { agentRow } from "../src/stats/agents";

const dirs: string[] = [];
const DAY = 24 * 60 * 60_000;
let calls = 0;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const iso = (at: number): string => new Date(at).toISOString();
const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const header = (id: string, parentSession?: string): string => line({ type: "session", version: 3, id, timestamp: iso(0), cwd: "/x", ...(parentSession === undefined ? {} : { parentSession }) });
const init = (agent: string, task = "Complete assignment thoroughly:\n\nDo it."): string => line({ type: "session_init", systemPrompt: "Read skill://canvas first", task, agent });
const prompt = (text: string): string => line({ type: "message", id: "u", timestamp: iso(0), message: { role: "user", content: [{ type: "text", text }] } });
/** An assistant turn reading each path; returns the line and its tool call ids. */
function reads(at: number, ...paths: string[]): string {
  return line({
    type: "message",
    id: "a",
    timestamp: iso(at),
    message: { role: "assistant", content: paths.map((path) => ({ type: "toolCall", id: `call_${String((calls += 1))}`, name: "read", arguments: { path } })) },
  });
}

function fixture(): { root: string; deps: UsageDeps; write: (path: string, text: string) => string; abs: (path: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "relay-skills-usage-"));
  dirs.push(root);
  const abs = (path: string): string => join(root, path);
  const write = (path: string, text: string): string => {
    mkdirSync(dirname(abs(path)), { recursive: true });
    writeFileSync(abs(path), text);
    return abs(path);
  };
  return {
    root,
    abs,
    write,
    deps: { home: root, agentHome: abs("Eva"), assistantsDir: abs(".config/relay/assistants"), cacheFile: abs("cache/usage.json"), logFile: abs(".omp/usage/skills.jsonl") },
  };
}

describe("skillOfPath", () => {
  it("reads the skill and a ranged read out of a skill:// path; a file inside a skill is no load", () => {
    expect(skillOfPath("skill://canvas")).toEqual({ skill: "canvas", ranged: false });
    expect(skillOfPath("skill://canvas/SKILL.md")).toEqual({ skill: "canvas", ranged: false });
    expect(skillOfPath("skill://canvas:50-80")).toEqual({ skill: "canvas", ranged: true });
    expect(skillOfPath("skill://canvas:raw")).toEqual({ skill: "canvas", ranged: false });
    expect(skillOfPath("skill://plug:tool")).toEqual({ skill: "plug:tool", ranged: false });
    expect(skillOfPath("skill://plug:tool:1-20")).toEqual({ skill: "plug:tool", ranged: true });
    expect(skillOfPath("skill://canvas/rules/a.md")).toBeNull();
    expect(skillOfPath("/Users/x/skill://canvas")).toBeNull();
    // omp's name for a copy whose name another source took.
    expect(skillOfPath("skill://agents/hallmark")).toEqual({ skill: "agents/hallmark", ranged: false });
    expect(skillOfPath("skill://agents/hallmark/SKILL.md")).toEqual({ skill: "agents/hallmark", ranged: false });
  });
});

describe("SkillUsageIndex", () => {
  it("attributes each load to the agent that made it and the assistant it worked for", async () => {
    const now = Date.now();
    const f = fixture();
    const sessions = ".omp/profiles/personal/agent/sessions/-Eva";
    // Nova's thread (the host's assistant record), and a scout it spawned.
    const nova = f.write(`${sessions}/nova.jsonl`, header("n1") + reads(now - DAY, "skill://canvas"));
    f.write(`${sessions}/nova/Look.jsonl`, header("n1a", nova) + init("scout") + reads(now - DAY, "skill://canvas", "skill://work"));
    f.write(".config/relay/assistants/nova.json", JSON.stringify({ sessionFile: nova, history: [] }));
    f.write(".config/relay/assistants/nova.asks.json", "[]");
    // An agent session Nova started (rotated once), and a helper inside the rotated file.
    const run = f.write(`${sessions}/run1.jsonl`, header("r1") + reads(now - 2 * DAY, "skill://work"));
    const rotated = f.write(`${sessions}/run2.jsonl`, header("r2") + reads(now - 2 * DAY, "skill://work"));
    f.write(`${sessions}/run2/Fix.jsonl`, header("r2a", rotated) + init("helper-code") + reads(now - 2 * DAY, "skill://work"));
    f.write("Eva/work/eva/agent-sessions/run.json", JSON.stringify({ owner: "nova", agent: "helper-deep", sessionFile: rotated, sessionFiles: [run], rotations: [{ from: run, to: rotated }] }));
    // A session Astra started (her sessions.json), a job and Eren, Elysia, Claude Code, and a stray chat.
    const auto = f.write(".omp/profiles/work/agent/sessions/-Eva/auto.jsonl", header("w1") + reads(now - 3 * DAY, "skill://work"));
    f.write("Eva/work/eva/agents/astra/sessions.json", JSON.stringify([{ id: "x", sessionFile: auto, title: "ENG-1 auto-work" }]));
    f.write(".omp/agent/sessions/-Eva/job.jsonl", header("j1") + prompt('You are executing Eva job "nightly", run 1, unattended.') + reads(now - 3 * DAY, "skill://canvas"));
    f.write("Eva/jobs/nightly/job.md", "---\nname: nightly\nagent: polaris\n---\n# Nightly\n");
    const chat = f.write(".omp/agent/sessions/-Eva/chat.jsonl", header("c1") + prompt("hello") + reads(now - 4 * DAY, "skill://canvas"));
    f.write(".omp/agent/sessions/-Eva/chat/Eren.jsonl", header("c1a", chat) + init("task", "Complete assignment thoroughly:\n\nYou are Eren, Eva's assistant. Do: tidy.") + reads(now - 4 * DAY, "skill://work"));
    f.write(".omp/agent/sessions-archive/-Eva/elysia.jsonl", header("e1") + prompt("You are Elysia, Isaac's autonomous background synthesizer") + reads(now - 5 * DAY, "skill://canvas"));
    f.write(
      ".claude/projects/-Users-x/abc.jsonl",
      line({ type: "assistant", sessionId: "abc", timestamp: iso(now - 6 * DAY), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "canvas" } }] } }),
    );

    const index = new SkillUsageIndex(f.deps);
    expect(index.usage("canvas")).toBeNull();
    await index.refresh();
    const by = (name: string): string[] => (index.usage(name)?.byAgent ?? []).map((row) => `${row.kind}:${row.agent}:${row.owner ?? "-"}=${String(row.uses)}`).sort();
    expect(by("canvas")).toEqual(["assistant:nova:-=1", "background:elysia:-=1", "claude:claude-code:-=1", "job:nightly:polaris=1", "other:other:-=1", "subagent:scout:nova=1"]);
    expect(by("work")).toEqual(["background:eren:-=1", "session:helper-deep:nova=2", "session:session:astra=1", "subagent:helper-code:nova=1", "subagent:scout:nova=1"]);
    expect(index.usage("canvas")).toMatchObject({ uses: 6, uses7d: 6, uses30d: 6, lastUsedAt: now - DAY, firstUsedAt: now - 6 * DAY });
    expect(index.usage("never")).toMatchObject({ uses: 0, lastUsedAt: null, byAgent: [] });

    // Settings > Usage folds the same runners into its by-agent rows.
    const runnerOf = await index.runners();
    const row = (path: string): string => agentRow(runnerOf(path)).label;
    expect([nova, `${nova.slice(0, -".jsonl".length)}/Look.jsonl`, run, auto, chat].map(row)).toEqual(["Nova", "Helpers", "Nova", "Astra", "Other"]);
    expect(row(f.abs(".omp/agent/sessions/-Eva/job.jsonl"))).toBe("Polaris");
    expect(row(f.abs(".omp/agent/sessions/-Eva/chat/Eren.jsonl"))).toBe("Eren");
    expect(row(f.abs(".omp/agent/sessions/-Eva/never.jsonl"))).toBe("Other");
  });

  it("counts a skill read once: files inside it, ranged re-reads, quoted paths and repeated tool calls are no new loads", async () => {
    const now = Date.now();
    const f = fixture();
    const body =
      header("s1") +
      reads(now - 3 * DAY, "skill://canvas:1-40") +
      reads(now - 3 * DAY, "skill://canvas:41-80", "skill://canvas/rules/a.md") +
      reads(now - 2 * DAY, "skill://canvas") +
      // omp's own tool-start record and an agent quoting the JSON are not reads.
      line({ type: "custom", customType: "tool_execution_start", data: { toolName: "read", args: { path: "skill://canvas" } } }) +
      line({ type: "message", timestamp: iso(now), message: { role: "toolResult", content: [{ type: "text", text: '"path":"skill://canvas"' }] } }) +
      line({ type: "custom_message", customType: "skill-prompt", id: "e9", timestamp: iso(now - DAY), content: '[IMPORTANT: User invoked the "canvas" skill; follow its instructions.]' });
    f.write(".omp/agent/sessions/-Eva/s.jsonl", body);
    // A forked copy repeats the same tool calls.
    f.write(".omp/agent/sessions/-Eva/fork.jsonl", body);
    const index = new SkillUsageIndex(f.deps);
    await index.refresh();
    const usage = index.usage("canvas");
    expect(usage?.uses).toBe(3);
    // Today is last in the trend.
    expect(usage?.daily).toHaveLength(TREND_DAYS);
    expect(usage?.daily.slice(-4)).toEqual([1, 1, 1, 0]);
  });

  it("takes back a load whose result failed, in omp and Claude Code, even when the result arrives in a later scan", async () => {
    let now = Date.now();
    const f = fixture();
    const failed = (toolCallId: string): string => line({ type: "message", timestamp: iso(now), message: { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: "Unknown skill: relay-widgets" }], isError: true } });
    const file = f.write(
      ".omp/agent/sessions/-Eva/s.jsonl",
      header("s1") +
        line({ type: "message", timestamp: iso(now), message: { role: "assistant", content: [{ type: "toolCall", id: "call_bad", name: "read", arguments: { path: "skill://relay-widgets" } }] } }) +
        reads(now, "skill://canvas"),
    );
    f.write(
      ".claude/projects/p/c.jsonl",
      line({ type: "assistant", timestamp: iso(now), message: { content: [{ type: "tool_use", id: "toolu_bad", name: "Skill", input: { skill: "nope" } }] } }) +
        line({ type: "user", timestamp: iso(now), message: { content: [{ type: "tool_result", tool_use_id: "toolu_bad", is_error: true, content: "Unknown skill: nope" }] } }),
    );
    const index = new SkillUsageIndex({ ...f.deps, now: () => now });
    await index.refresh();
    expect(index.usage("relay-widgets")?.uses).toBe(1);
    expect(index.usage("nope")?.uses).toBe(0);
    appendFileSync(file, failed("call_bad"));
    now += USAGE_REFRESH_MS + 1;
    await index.refresh();
    expect(index.usage("relay-widgets")?.uses).toBe(0);
    expect(index.usage("canvas")?.uses).toBe(1);
  });

  it("reads only what was appended, again from the start when a file was rewritten, and stays warm across restarts", async () => {
    let now = Date.now();
    const f = fixture();
    const file = f.write(".omp/agent/sessions/-Eva/s.jsonl", header("s1") + reads(now - DAY, "skill://canvas"));
    const index = new SkillUsageIndex({ ...f.deps, now: () => now });
    await index.refresh();
    const first = index.lastScan;
    expect(first?.read).toBe(1);
    // A half-written line waits for its newline.
    const added = reads(now, "skill://canvas");
    appendFileSync(file, added.slice(0, 20));
    now += USAGE_REFRESH_MS + 1;
    await index.refresh();
    expect(index.usage("canvas")?.uses).toBe(1);
    appendFileSync(file, added.slice(20));
    now += USAGE_REFRESH_MS + 1;
    await index.refresh();
    expect(index.usage("canvas")?.uses).toBe(2);
    expect(index.lastScan?.bytes).toBe(added.length);

    // A restart answers from the stored records at once and reads nothing.
    const restarted = new SkillUsageIndex({ ...f.deps, now: () => now });
    expect(restarted.usage("canvas")?.uses).toBe(2);
    await restarted.refresh();
    expect(restarted.lastScan).toMatchObject({ files: 1, read: 0, bytes: 0 });

    // Rewritten in place, longer: the bytes before the old offset changed, so it is read again.
    writeFileSync(file, header("s1") + reads(now - DAY, "skill://work") + reads(now, "skill://work") + reads(now, "skill://work"));
    now += USAGE_REFRESH_MS + 1;
    await restarted.refresh();
    expect(restarted.usage("canvas")?.uses).toBe(0);
    expect(restarted.usage("work")?.uses).toBe(3);

    // A deleted transcript keeps its loads.
    rmSync(file);
    now += USAGE_REFRESH_MS + 1;
    await restarted.refresh();
    expect(restarted.usage("work")?.uses).toBe(3);
  });

  it("adds the hook's logged loads that no transcript holds, once", async () => {
    const now = Date.now();
    const f = fixture();
    f.write(
      ".omp/agent/sessions/-Eva/s.jsonl",
      header("s1") +
        line({ type: "message", timestamp: iso(now - DAY), message: { role: "assistant", content: [{ type: "toolCall", id: "call_live", name: "read", arguments: { path: "skill://canvas" } }] } }) +
        line({ type: "custom_message", customType: "skill-prompt", id: "e1", timestamp: iso(now - DAY), content: 'User invoked the "work" skill' }),
    );
    const logged = (over: Record<string, unknown>): string =>
      line({ v: 1, at: now - DAY, skill: "canvas", how: "read", agent: "nova", kind: "assistant", owner: null, sessionId: "s1", toolCallId: "call_live", cwd: "/x", profile: null, ...over });
    f.write(
      ".omp/usage/skills.jsonl",
      // Also in the transcript: the tool call, and the same /skill:work a few seconds earlier.
      logged({}) +
        logged({ how: "slash", skill: "work", toolCallId: null, at: now - DAY - 3000 }) +
        // Only in the log: a load from a session whose transcript is gone.
        logged({ toolCallId: "call_gone", agent: "scout", kind: "subagent", owner: "astra", at: now - 2 * DAY }) +
        "not json\n",
    );
    const index = new SkillUsageIndex(f.deps);
    await index.refresh();
    expect(index.usage("canvas")?.uses).toBe(2);
    expect(index.usage("canvas")?.byAgent.map((row) => `${row.agent}:${row.owner ?? "-"}`).sort()).toEqual(["other:-", "scout:astra"]);
    expect(index.usage("work")?.uses).toBe(1);
  });
});
