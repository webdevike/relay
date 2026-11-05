import { describe, expect, it } from "vitest";
import type { AgentAsk } from "@relay/protocol";
import { advancesOnPick, answersOf, firstUnanswered, initialDraft, isAnswered, reduceAsk, type AskAction, type AskDraft } from "./askState";

const ask: AgentAsk = {
  id: "k1",
  questions: [
    { id: "q1", question: "Which branch?", options: [{ label: "main", description: "x".repeat(400) }, { label: "dev" }], recommended: 0 },
    { id: "q2", question: "Which checks?", multi: true, options: [{ label: "lint" }, { label: "types" }, { label: "e2e" }] },
    { id: "q3", question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] },
  ],
};

const run = (...actions: AskAction[]): AskDraft => actions.reduce((draft, action) => reduceAsk(ask, draft, action), initialDraft);

describe("ask card state", () => {
  it("walks three pages: a single pick advances, a multi page waits for Next, the last page submits", () => {
    expect(advancesOnPick(ask, 0)).toBe(true);
    expect(advancesOnPick(ask, 1)).toBe(false);
    expect(advancesOnPick(ask, 2)).toBe(false);
    let draft = run({ type: "pick", index: 0, label: "dev" }, { type: "advance", from: 0 });
    expect(draft.step).toBe(1);
    draft = [
      { type: "pick", index: 1, label: "lint" },
      { type: "pick", index: 1, label: "e2e" },
    ].reduce((d, a) => reduceAsk(ask, d, a as AskAction), draft);
    expect(draft.step).toBe(1);
    draft = reduceAsk(ask, draft, { type: "advance", from: 1 });
    draft = reduceAsk(ask, draft, { type: "pick", index: 2, label: "Yes" });
    expect(draft.step).toBe(2);
    expect(firstUnanswered(ask, draft)).toBe(-1);
    expect(answersOf(ask, draft)).toEqual([
      { id: "q1", selectedOptions: ["dev"] },
      { id: "q2", selectedOptions: ["lint", "e2e"] },
      { id: "q3", selectedOptions: ["Yes"] },
    ]);
  });

  it("multi-select toggles each option on and off", () => {
    const draft = run({ type: "pick", index: 1, label: "lint" }, { type: "pick", index: 1, label: "types" }, { type: "pick", index: 1, label: "lint" });
    expect(draft.selections["q2"]).toEqual(["types"]);
  });

  it("single-select replaces the pick", () => {
    const draft = run({ type: "pick", index: 0, label: "main" }, { type: "pick", index: 0, label: "dev" });
    expect(draft.selections["q1"]).toEqual(["dev"]);
  });

  it("a double tap or a late timer never skips a page", () => {
    const draft = run({ type: "pick", index: 0, label: "main" }, { type: "advance", from: 0 }, { type: "advance", from: 0 });
    expect(draft.step).toBe(1);
    expect(run({ type: "advance", from: 0 }, { type: "back" }, { type: "advance", from: 0 }).step).toBe(1);
  });

  it("Back keeps earlier answers and never goes below the first page", () => {
    const draft = run({ type: "pick", index: 0, label: "main" }, { type: "advance", from: 0 }, { type: "back" }, { type: "back" });
    expect(draft.step).toBe(0);
    expect(draft.selections["q1"]).toEqual(["main"]);
  });

  it("a typed answer replaces the picks and a pick replaces the typed answer", () => {
    let draft = run({ type: "pick", index: 1, label: "lint" }, { type: "custom", index: 1, text: " all of them " });
    expect(draft.selections["q2"]).toEqual([]);
    expect(isAnswered(draft, "q2")).toBe(true);
    expect(answersOf(ask, draft)[1]).toEqual({ id: "q2", selectedOptions: [], customInput: "all of them" });
    draft = reduceAsk(ask, draft, { type: "pick", index: 1, label: "types" });
    expect(draft.customs["q2"]).toBe("");
    expect(answersOf(ask, draft)[1]).toEqual({ id: "q2", selectedOptions: ["types"] });
  });

  it("finds the first page without an answer so Submit can jump to it", () => {
    const draft = run({ type: "pick", index: 0, label: "main" }, { type: "pick", index: 2, label: "No" });
    expect(firstUnanswered(ask, draft)).toBe(1);
    expect(reduceAsk(ask, draft, { type: "goto", index: firstUnanswered(ask, draft) }).step).toBe(1);
    expect(reduceAsk(ask, draft, { type: "goto", index: 9 }).step).toBe(2);
  });
});
