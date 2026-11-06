import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentAsk, type AssistantMessage, MAX_ASK_LABEL, MAX_ASK_QUESTION, MAX_OPEN_ASKS } from "@relay/protocol";
import { AskStore, CLOSED_ASK_TTL_MS, defaultAsksPath } from "../src/assistant/ask-store";
import { askId, askKey, askLabel, askQuestion } from "../src/assistant/asks";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-asks-"));
  dirs.push(dir);
  return join(dir, "assistants", "nova.asks.json");
}

/** A settled assistant row that ended on answers, and a user row. */
const asked = (id: string, text: string, at: number, replies = ["Yes", "Not yet"]): AssistantMessage => ({ id, role: "assistant", text, at, replies });
const said = (id: string, text: string, at: number): AssistantMessage => ({ id, role: "user", text, at });
/** `asking` for the rows: every assistant row with replies, with the given labels. */
const asking = (rows: readonly AssistantMessage[], labels: Record<string, string> = {}): Map<string, string | undefined> =>
  new Map(rows.filter((row) => row.role === "assistant" && row.replies !== undefined).map((row) => [row.id, labels[row.id]]));

function store(path: string | null = null) {
  const clock = { now: 1_000 };
  const asks = new AskStore(path, () => clock.now);
  const observe = (rows: readonly AssistantMessage[], labels?: Record<string, string>): boolean => asks.observe(rows, asking(rows, labels));
  return { asks, clock, observe };
}

const card = (id: string, question: string, extra: Partial<AgentAsk["questions"][number]> = {}): AgentAsk => ({
  id,
  questions: [{ id: "q1", question, options: [{ label: "Ship it" }, { label: "Hold" }], ...extra }, { id: "q2", question: "And then?", options: [{ label: "x" }] }],
});

describe("askQuestion", () => {
  it("takes the last sentence that asks something, as plain text", () => {
    expect(askQuestion("I fixed the flaky test. Want me to push it? It is on a branch.")).toBe("Want me to push it?");
    expect(askQuestion("Done.\n\nShould I **merge** [PR 12](https://github.com/x/y/pull/12) now?")).toBe("Should I merge PR 12 now?");
    expect(askQuestion("## Status\n\n- one\n- two\n\n> Is `main` safe to deploy?")).toBe("Is main safe to deploy?");
    expect(askQuestion("Is this right?\n```ts\nconst a = b ? c : d;\nwhy?\n```\nLet me know.")).toBe("Is this right?");
    expect(askQuestion("![shot](a.png) Which one do you like better? Or neither?")).toBe("Or neither?");
  });

  it("falls back to the last sentence when nothing ends in a question mark", () => {
    expect(askQuestion("The build is green. Pick one of the options below.")).toBe("Pick one of the options below.");
    expect(askQuestion("```\nonly code\n```")).toBe("");
  });

  it("clips a long question", () => {
    const question = askQuestion(`${"very ".repeat(80)}long?`);
    expect(question.length).toBeLessThanOrEqual(MAX_ASK_QUESTION);
    expect(question.endsWith("…")).toBe(true);
  });
});

describe("askLabel, askKey and askId", () => {
  it("uses an explicit label, else the question cut at a word", () => {
    expect(askLabel("Want me to push it?", "Push the fix")).toBe("Push the fix");
    expect(askLabel("Want me to push it?", "   ")).toBe("Want me to push it?");
    const label = askLabel("Should I move the Thursday standup to Friday morning instead?");
    expect(label.length).toBeLessThanOrEqual(MAX_ASK_LABEL);
    expect(label).toBe("Should I move the Thursday standup to…");
  });

  it("drops a lead-in before a colon when the rest stands alone, and keeps a short rest or a time", () => {
    expect(askLabel("Last one for today: want me to open the PR for the arena fix?")).toBe("Want me to open the PR for the arena…");
    expect(askLabel("Quick one: ship it?")).toBe("Quick one: ship it?");
    expect(askLabel("Book the 7:10 tee time?")).toBe("Book the 7:10 tee time?");
  });

  it("keys a question without case, punctuation or extra spaces, and ids are 8 hex", () => {
    expect(askKey("Want me to  PUSH it?")).toBe(askKey("want me to push it"));
    expect(askId("seed")).toMatch(/^[0-9a-f]{8}$/);
    expect(askId("seed")).toBe(askId("seed"));
    expect(askId("seed")).not.toBe(askId("other"));
  });
});

describe("AskStore", () => {
  it("opens an ask for a replies row since the store began, with its ask-label, and never for older rows", () => {
    const { asks, observe } = store();
    const rows = [asked("old", "Old news?", 999), asked("a1", "Fixed it. Want me to push?", 1_500)];
    expect(observe(rows, { a1: "Push the fix" })).toBe(true);
    expect(asks.open()).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}$/) as string, source: "replies", label: "Push the fix", question: "Want me to push?", replies: ["Yes", "Not yet"], at: 1_500, messageId: "a1" }]);
    expect(observe(rows, { a1: "Push the fix" })).toBe(false);
  });

  it("resolves and dismisses by id, and says whether it was open", () => {
    const { asks, observe } = store();
    observe([asked("a1", "Push?", 1_100), asked("a2", "Deploy?", 1_200)]);
    const [push, deploy] = asks.open();
    expect(asks.resolve(push?.id ?? "", "dismissed")).toBe(true);
    expect(asks.resolve(push?.id ?? "", "resolved")).toBe(false);
    expect(asks.resolve("ffffffff", "resolved")).toBe(false);
    expect(asks.open().map((ask) => ask.id)).toEqual([deploy?.id]);
  });

  it("is answered by a later user row that is exactly one of its replies, and stays open on free text", () => {
    const { asks, observe } = store();
    const ask = asked("a1", "Push?", 1_100);
    observe([said("u0", "yes", 1_050), ask, said("u1", "hmm, let me think about it", 1_200)]);
    expect(asks.open()).toHaveLength(1);
    observe([said("u0", "yes", 1_050), ask, said("u1", "hmm, let me think about it", 1_200), said("u2", "  not YET ", 1_300)]);
    expect(asks.open()).toEqual([]);
  });

  it("refreshes an open ask asked again instead of adding a second, but a closed one asked again is a new ask", () => {
    const { asks, observe } = store();
    const first = asked("a1", "Want me to push it?", 1_100);
    observe([first]);
    const [open] = asks.open();
    const again = asked("a2", "Still there. Want me to push it", 1_200, ["Push", "Wait"]);
    observe([first, again]);
    expect(asks.open()).toHaveLength(1);
    expect(asks.open()[0]).toMatchObject({ id: open?.id, at: 1_200, messageId: "a2", replies: ["Push", "Wait"] });
    asks.resolve(open?.id ?? "", "answered");
    observe([first, again]);
    expect(asks.open()).toEqual([]);
    observe([first, again, asked("a3", "Want me to push it?", 1_300)]);
    expect(asks.open()).toHaveLength(1);
    expect(asks.open()[0]?.id).not.toBe(open?.id);
  });

  it("follows a row to its new id after the rollover instead of adding it again", () => {
    const { asks, observe } = store();
    observe([asked("live-7", "Push?", 1_100)]);
    const [open] = asks.open();
    observe([asked("2026-11-05T0400_aaaa-7", "Push?", 1_100)]);
    expect(asks.open()).toEqual([{ ...open, messageId: "2026-11-05T0400_aaaa-7" }]);
  });

  it("keeps the newest MAX_OPEN_ASKS, oldest first", () => {
    const { asks, observe } = store();
    observe(Array.from({ length: MAX_OPEN_ASKS + 3 }, (_, index) => asked(`a${String(index)}`, `Question number ${String(index)}?`, 1_100 + index)));
    const open = asks.open();
    expect(open).toHaveLength(MAX_OPEN_ASKS);
    expect(open[0]?.question).toBe("Question number 3?");
    expect(open.at(-1)?.question).toBe(`Question number ${String(MAX_OPEN_ASKS + 2)}?`);
  });

  it("turns an ask card into an ask: header as label, option labels as answers; answered closes it, a cancel leaves it open", () => {
    const { asks } = store();
    expect(asks.addCard("s1", card("k1", "Ship the release   today?", { header: "Release" }))).toBe(true);
    expect(asks.addCard("s1", card("k1", "Ship the release today?", { header: "Release" }))).toBe(false);
    expect(asks.open()).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{8}$/) as string, source: "ask", label: "Release", question: "Ship the release today?", replies: ["Ship it", "Hold"], at: 1_000, sessionId: "s1", askId: "k1" }]);
    expect(asks.cardResolved("s1", "k1", false)).toBe(false);
    expect(asks.open()).toHaveLength(1);
    expect(asks.cardResolved("s1", "k1", true)).toBe(true);
    expect(asks.open()).toEqual([]);
    asks.addCard("s1", card("k2", "Which branch do we cut the release from?"));
    expect(asks.open()[0]?.label).toBe(askLabel("Which branch do we cut the release from?"));
  });

  it("answers an ask card from a later user row that is one of its options", () => {
    const { asks, clock, observe } = store();
    asks.addCard("s1", card("k1", "Ship it?"));
    observe([said("u1", "Hold", 999)]);
    expect(asks.open()).toHaveLength(1);
    clock.now = 2_000;
    observe([said("u1", "Hold", 999), said("u2", "hold", 1_500)]);
    expect(asks.open()).toEqual([]);
  });

  it("persists to its file (0600) and a new store on the same file carries on, since included", () => {
    const path = tempFile();
    const one = store(path);
    one.observe([asked("a1", "Push?", 1_100)]);
    const [open] = one.asks.open();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    const two = store(path);
    two.clock.now = 50_000;
    expect(two.asks.open()).toEqual([open]);
    // `since` stayed at the first store's start: a row from before it still never opens.
    two.observe([asked("a0", "Earlier?", 900)]);
    expect(two.asks.resolve(open?.id ?? "", "resolved")).toBe(true);
    expect(store(path).asks.open()).toEqual([]);
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(saved).toMatchObject({ since: 1_000 });
  });

  it("starts `since` at the first look and writes only on a change", () => {
    const path = tempFile();
    const { asks, observe } = store(path);
    expect(asks.open()).toEqual([]);
    const written = statSync(path).mtimeMs;
    expect(observe([said("u1", "hello", 2_000)])).toBe(false);
    expect(statSync(path).mtimeMs).toBe(written);
  });

  it("prunes asks closed over 30 days ago and raises since past them so their rows cannot come back", () => {
    const path = tempFile();
    const { asks, clock, observe } = store(path);
    const row = asked("a1", "Push?", 1_100);
    observe([row]);
    asks.resolve(asks.open()[0]?.id ?? "", "dismissed");
    clock.now = 1_000 + CLOSED_ASK_TTL_MS + 10;
    observe([row]);
    const record: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(record).toEqual({ since: 1_101, asks: [] });
  });

  it("lives beside the thread file", () => {
    expect(defaultAsksPath("nova").endsWith(join("relay", "assistants", "nova.asks.json"))).toBe(true);
  });

  it("keeps a session's ask with its from, default and a label that leads with who asks", () => {
    const { asks } = store();
    const ask = asks.addSession({ from: "Golf", sessionId: "s1", question: "Last one for today: book the 7:10 tee time?", options: ["Book it", "Skip"], default: "Book it" });
    expect(asks.open()).toEqual([{ id: ask.id, source: "session", label: "Golf: Book the 7:10 tee time?", question: "Last one for today: book the 7:10 tee time?", replies: ["Book it", "Skip"], at: 1_000, from: "Golf", sessionId: "s1", default: "Book it" }]);
  });

  it("refreshes a session's ask asked again by the same session while open, but not another session's or a thread row's", () => {
    const { asks, clock, observe } = store();
    const first = asks.addSession({ from: "Golf", sessionId: "s1", question: "Book the tee time?", options: ["Book it", "Skip"] });
    clock.now = 1_500;
    expect(asks.addSession({ from: "Golf", sessionId: "s1", question: "Book the tee time", options: ["Book it", "Skip", "Later"] }).id).toBe(first.id);
    expect(asks.open()).toMatchObject([{ id: first.id, at: 1_500, replies: ["Book it", "Skip", "Later"] }]);
    expect(asks.addSession({ from: "Trip", sessionId: "s2", question: "Book the tee time?", options: ["Yes", "No"] }).id).not.toBe(first.id);
    observe([asked("a1", "Book the tee time?", 1_600)]);
    expect(asks.open().map((ask) => ask.source)).toEqual(["session", "session", "replies"]);
  });

  it("is not answered by a thread row that matches one of its options: the answer belongs to the asking session", () => {
    const { asks, clock, observe } = store();
    asks.addSession({ from: "Golf", sessionId: "s1", question: "Book it?", options: ["Book it", "Skip"] });
    clock.now = 2_000;
    observe([said("u1", "Skip", 1_500)]);
    expect(asks.open()).toHaveLength(1);
  });

  it("keeps the answer and the delivery on a closed ask, which get still reads", () => {
    const { asks } = store();
    const { id } = asks.addSession({ from: "Golf", question: "Book it?", options: ["Book it", "Skip"] });
    expect(asks.resolve(id, "answered", "Skip")).toBe(true);
    expect(asks.get(id)).toMatchObject({ state: "answered", answer: "Skip", from: "Golf" });
    expect(asks.get(id)?.delivered).toBeUndefined();
    asks.markDelivered(id);
    expect(asks.get(id)?.delivered).toBe(true);
    expect(asks.open()).toEqual([]);
  });
});
