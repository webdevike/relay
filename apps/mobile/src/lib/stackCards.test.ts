import { describe, expect, it } from "vitest";
import type { AgentApproval, AgentAsk, OpenAsk } from "@relay/protocol";
import type { RunningCard } from "./activity";
import { stackCards, type StackSources } from "./stackCards";

const ask = (id: string, at: number, over: Partial<OpenAsk> = {}): OpenAsk => ({ id, source: "replies", label: `Label ${id}`, question: `Question ${id}?`, replies: ["Yes", "No"], at, ...over });
const run = (id: string, over: Partial<RunningCard> = {}): RunningCard => ({ id, title: id, waiting: false, model: null, vendor: null, work: [], ...over });
const approval: AgentApproval = { id: "ap1", toolName: "bash", command: "rm -rf build", requiresBiometric: false };
const form = (questions: AgentAsk["questions"]): AgentAsk => ({ id: "f1", questions });
const NONE: StackSources = { approval: null, form: null, asks: [], running: [] };

describe("stackCards", () => {
  it("has no cards when nothing needs Isaac and nothing runs", () => {
    expect(stackCards(NONE)).toEqual([]);
  });

  it("orders the session's blocking card, then open asks oldest first, then running work", () => {
    const cards = stackCards({
      approval: { sessionId: "S", approval },
      form: null,
      asks: [ask("bbbbbbbb", 20), ask("aaaaaaaa", 10)],
      running: [run("wait", { waiting: true }), run("busy")],
    });
    expect(cards.map((card) => card.id)).toEqual(["approval:S", "ask:aaaaaaaa", "ask:bbbbbbbb", "run:wait", "run:busy"]);
    expect(cards[0]).toMatchObject({ kind: "approval", title: "Allow bash?", sessionId: "S" });
  });

  it("shows the ask form only without an approval, titled by its header, else its question, else how many it asks", () => {
    const one = form([{ id: "q", header: "Auth", question: "Which auth method?", options: [] }] as AgentAsk["questions"]);
    expect(stackCards({ ...NONE, form: one })[0]).toMatchObject({ kind: "form", id: "askcard:f1", title: "Auth" });
    expect(stackCards({ ...NONE, approval: { sessionId: "S", approval }, form: one }).map((card) => card.id)).toEqual(["approval:S"]);
    const bare = form([{ id: "q", question: "Which auth method?", options: [] }] as AgentAsk["questions"]);
    expect(stackCards({ ...NONE, form: bare })[0]?.title).toBe("Which auth method?");
    const two = form([{ id: "a", question: "A?", options: [] }, { id: "b", question: "B?", options: [] }] as AgentAsk["questions"]);
    expect(stackCards({ ...NONE, form: two })[0]?.title).toBe("2 questions");
  });

  it("titles a question card by its label, with the whole question and a session ask's default as the detail", () => {
    const [labelled, plain, session] = stackCards({
      ...NONE,
      asks: [
        ask("aaaaaaaa", 1, { label: "Drone design", question: "Which drone design should we build?" }),
        ask("bbbbbbbb", 2, { label: "Ship it?", question: "Ship it?" }),
        ask("cccccccc", 3, { source: "session", label: "Golf: tee time", question: "Which tee time?", replies: ["9:00", "10:30"], default: "9:00" }),
      ],
    });
    expect(labelled).toMatchObject({ kind: "question", title: "Drone design", detail: "Which drone design should we build?" });
    expect(plain).toMatchObject({ title: "Ship it?", detail: null });
    expect(session).toMatchObject({ detail: "Which tee time?\nGoing with 9:00 unless you say otherwise." });
  });

  it("keeps each running card's own data for the card to draw", () => {
    const busy = run("helper:/s/T/A.jsonl", { title: "Guardian look", startedAt: 5, model: "Opus 5.5 high", vendor: "anthropic", work: ["a", "b"], sessionId: "T:A" });
    expect(stackCards({ ...NONE, running: [busy] })).toEqual([{ kind: "running", id: "run:helper:/s/T/A.jsonl", title: "Guardian look", run: busy }]);
  });
});
