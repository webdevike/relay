import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@relay/protocol";
import { REACTION_NOTE_DELAY_MS, ReactionService, reactionNote, type ReactionFeedback } from "../src/reactions/service";
import type { SessionClock } from "../src/session";

class FakeClock implements SessionClock {
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  private current = 1_000;
  now(): number {
    return this.current;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Drains the microtasks a note delivery runs through (the fake `note` answers at once). */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
}

function setup(options: { sessions?: Record<string, string>; takes?: (sessionId: string) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-reactions-"));
  dirs.push(dir);
  const clock = new FakeClock();
  const sent: ServerMessage[] = [];
  const notes: [string, string][] = [];
  const sessions: Record<string, string> = { ...options.sessions };
  const logged: string[] = [];
  const make = (): ReactionService =>
    new ReactionService({
      path: join(dir, "relay", "reactions.json"),
      feedbackPath: (agent) => join(dir, "agents", agent, "reactions.jsonl"),
      broadcast: (message) => sent.push(message),
      session: (thread) => sessions[thread] ?? null,
      note: (sessionId, text) => {
        notes.push([sessionId, text]);
        return Promise.resolve(options.takes?.(sessionId) ?? true);
      },
      clock,
      log: (line) => logged.push(line),
    });
  return { dir, clock, sent, notes, sessions, logged, make, service: make() };
}

describe("reactionNote", () => {
  it("says what changed since the last note, oldest bubble first, and that no answer is needed", () => {
    const long = "x".repeat(100);
    const note = reactionNote(
      { "assistant@30": { emoji: "👍", excerpt: "Shipped it." }, "user@10": { emoji: "❤️", excerpt: "thanks" }, "assistant@50": { emoji: "😂", excerpt: "same" } },
      { "assistant@30": { emoji: "👎", excerpt: "Shipped it.", at: 1 }, "assistant@20": { emoji: "❓", excerpt: long, at: 1 }, "assistant@50": { emoji: "😂", excerpt: "same", at: 1 } },
    );
    expect(note.split("\n")).toEqual([
      '[Isaac removed his ❤️ reaction from his own message: "thanks"]',
      `[Isaac reacted ❓ to your message: "${"x".repeat(80)}…"]`,
      '[Isaac reacted 👎 to your message: "Shipped it."]',
      "(Reactions are quiet feedback from Isaac: take them into account, no need to answer them.)",
    ]);
    expect(reactionNote({ "user@1": { emoji: "👍", excerpt: "a" } }, { "user@1": { emoji: "👍", excerpt: "a", at: 2 } })).toBe("");
  });
});

describe("ReactionService", () => {
  it("sets, replaces and clears one reaction per bubble, sending the thread to every device each time", () => {
    const { service, sent } = setup();
    expect(service.set("assistant:astra", "assistant@5", "👍", "Done.")).toBe(true);
    expect(service.set("assistant:astra", "assistant@5", "👍", "Done.")).toBe(false);
    expect(service.set("assistant:astra", "assistant@5", "❤️", "Done.")).toBe(true);
    expect(service.snapshot("assistant:astra")).toEqual({ "assistant@5": { isaac: { emoji: "❤️", excerpt: "Done.", at: 1_000 } } });
    expect(service.clear("assistant:astra", "assistant@5")).toBe(true);
    expect(service.clear("assistant:astra", "assistant@5")).toBe(false);
    expect(service.snapshot("assistant:astra")).toEqual({});
    expect(sent).toEqual([
      { t: "reactions.snapshot", thread: "assistant:astra", reactions: { "assistant@5": { isaac: { emoji: "👍", excerpt: "Done.", at: 1_000 } } } },
      { t: "reactions.snapshot", thread: "assistant:astra", reactions: { "assistant@5": { isaac: { emoji: "❤️", excerpt: "Done.", at: 1_000 } } } },
      { t: "reactions.snapshot", thread: "assistant:astra", reactions: {} },
    ]);
  });

  it("keeps reactions across a restart in a private file", () => {
    const { service, make, dir } = setup();
    service.set("session:s1", "user@7", "‼️", "ship it");
    const file = join(dir, "relay", "reactions.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(make().snapshot("session:s1")).toEqual({ "user@7": { isaac: { emoji: "‼️", excerpt: "ship it", at: 1_000 } } });
  });

  it("logs a 👎 or ❓ on an assistant's reply in its thread as feedback, nothing else", () => {
    const { service, dir } = setup();
    service.set("assistant:astra", "assistant@1761580800000", "👎", "Here is the plan");
    service.set("assistant:astra", "assistant@1761580800000", "👍", "Here is the plan");
    service.set("assistant:astra", "assistant@1761580900000", "❓", "Why X?");
    service.set("assistant:astra", "user@1761580800000", "👎", "mine");
    service.set("session:s1", "assistant@1761580800000", "👎", "not an assistant thread");
    const lines = readFileSync(join(dir, "agents", "astra", "reactions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as ReactionFeedback);
    expect(lines).toEqual([
      { at: new Date(1_000).toISOString(), agent: "astra", reaction: "👎", signal: "thumbs-down", message: { at: "2025-10-27T16:00:00.000Z", excerpt: "Here is the plan" } },
      { at: new Date(1_000).toISOString(), agent: "astra", reaction: "❓", signal: "question", message: { at: "2025-10-27T16:01:40.000Z", excerpt: "Why X?" } },
    ]);
    expect(existsSync(join(dir, "agents", "session"))).toBe(false);
  });

  it("tells the thread's session once the reactions settle, as one quiet note, never before", async () => {
    const { service, clock, notes } = setup({ sessions: { "assistant:astra": "astra-1" } });
    service.set("assistant:astra", "assistant@5", "👍", "Done.");
    clock.advance(REACTION_NOTE_DELAY_MS - 1);
    service.set("assistant:astra", "assistant@5", "❤️", "Done.");
    service.set("assistant:astra", "user@3", "😂", "lol");
    clock.advance(REACTION_NOTE_DELAY_MS - 1);
    expect(notes).toEqual([]);
    clock.advance(1);
    await flush();
    expect(notes).toEqual([["astra-1", '[Isaac reacted 😂 to his own message: "lol"]\n[Isaac reacted ❤️ to your message: "Done."]\n(Reactions are quiet feedback from Isaac: take them into account, no need to answer them.)']]);
    // A take-back after the note is its own line; nothing else repeats.
    service.clear("assistant:astra", "user@3");
    clock.advance(REACTION_NOTE_DELAY_MS);
    await flush();
    expect(notes[1]).toEqual(["astra-1", '[Isaac removed his 😂 reaction from his own message: "lol"]\n(Reactions are quiet feedback from Isaac: take them into account, no need to answer them.)']);
    // Reacting and taking it back before the note goes out says nothing.
    service.set("assistant:astra", "assistant@9", "👍", "ok");
    service.clear("assistant:astra", "assistant@9");
    clock.advance(REACTION_NOTE_DELAY_MS);
    await flush();
    expect(notes).toHaveLength(2);
  });

  it("holds the note while no session runs the thread and hands it to the next one, even after a restart", async () => {
    const { service, clock, notes, sessions, make } = setup();
    service.set("session:s1", "assistant@5", "👍", "Done.");
    clock.advance(REACTION_NOTE_DELAY_MS);
    await flush();
    expect(notes).toEqual([]);
    const restarted = make();
    sessions["session:s1"] = "s1";
    restarted.observe({ kind: "sessions" });
    await flush();
    expect(notes.map(([session]) => session)).toEqual(["s1"]);
    restarted.observe({ kind: "sessions" });
    await flush();
    expect(notes).toHaveLength(1);
  });

  it("does not ask a session that turned a note down again, but asks the next one", async () => {
    const { service, clock, notes, sessions } = setup({ sessions: { "assistant:nova": "old" }, takes: (session) => session !== "old" });
    service.set("assistant:nova", "assistant@5", "❓", "Hmm");
    clock.advance(REACTION_NOTE_DELAY_MS);
    await flush();
    service.observe({ kind: "sessions" });
    await flush();
    expect(notes.map(([session]) => session)).toEqual(["old"]);
    sessions["assistant:nova"] = "new";
    service.observe({ kind: "sessions" });
    await flush();
    expect(notes.map(([session]) => session)).toEqual(["old", "new"]);
    service.observe({ kind: "sessions" });
    await flush();
    expect(notes).toHaveLength(2);
  });
  it("keeps an assistant's reaction beside Isaac's on the same bubble, quietly: no note, no feedback", async () => {
    const { service, clock, notes, dir } = setup({ sessions: { "assistant:astra": "astra-1" } });
    service.set("assistant:astra", "user@7", "👍", "ship it");
    expect(service.set("assistant:astra", "user@7", "❤️", "ship it", "astra")).toBe(true);
    expect(service.set("assistant:astra", "user@7", "❤️", "ship it", "astra")).toBe(false);
    service.set("assistant:astra", "assistant@9", "👎", "reply", "astra");
    expect(service.snapshot("assistant:astra")).toEqual({
      "user@7": { isaac: { emoji: "👍", excerpt: "ship it", at: 1_000 }, astra: { emoji: "❤️", excerpt: "ship it", at: 1_000 } },
      "assistant@9": { astra: { emoji: "👎", excerpt: "reply", at: 1_000 } },
    });
    expect(existsSync(join(dir, "agents", "astra", "reactions.jsonl"))).toBe(false);
    clock.advance(REACTION_NOTE_DELAY_MS);
    await flush();
    expect(notes).toEqual([["astra-1", '[Isaac reacted 👍 to his own message: "ship it"]\n(Reactions are quiet feedback from Isaac: take them into account, no need to answer them.)']]);
    expect(service.clear("assistant:astra", "user@7", "astra")).toBe(true);
    expect(service.snapshot("assistant:astra")["user@7"]).toEqual({ isaac: { emoji: "👍", excerpt: "ship it", at: 1_000 } });
    clock.advance(REACTION_NOTE_DELAY_MS);
    await flush();
    expect(notes).toHaveLength(1);
  });

  it("reads a file from before reactors as Isaac's reactions", () => {
    const { dir, make } = setup();
    mkdirSync(join(dir, "relay"), { recursive: true });
    writeFileSync(join(dir, "relay", "reactions.json"), JSON.stringify({ threads: { "session:s1": { "user@1": { emoji: "👍", excerpt: "a", at: 5 } } }, told: {} }));
    expect(make().snapshot("session:s1")).toEqual({ "user@1": { isaac: { emoji: "👍", excerpt: "a", at: 5 } } });
  });
});
