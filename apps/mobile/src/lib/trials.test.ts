import { describe, expect, it } from "vitest";
import {
  encode,
  parseClientMessage,
  type AssistantMessage,
  type Trial,
  type TrialSwitch,
  type TrialsSnapshot,
} from "@relay/protocol";
import { insertByAt, withAskRows } from "./openAsks";
import {
  armsInOrder,
  armStateText,
  canUndoSwitch,
  isTrialRow,
  switchLine,
  threadTrialRows,
  trialChoices,
  trialHeader,
  trialPickFrame,
  trialUndoFrame,
} from "./trials";

const NOVA = "assistant:nova";

function trial(id: string, at: number, overrides: Partial<Trial> = {}): Trial {
  return {
    id,
    agent: "diagram",
    label: "Diagram",
    thread: NOVA,
    at,
    request: "Draw the sync flow",
    arms: [
      { letter: "B", status: "done", preview: "B result" },
      { letter: "A", status: "done", preview: "A result" },
      { letter: "C", status: "running" },
    ],
    ...overrides,
  };
}

function switched(id: string, at: number, overrides: Partial<TrialSwitch> = {}): TrialSwitch {
  return {
    id,
    agent: "diagram",
    label: "Diagram",
    thread: NOVA,
    at,
    text: "Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks over Opus 5.5 and GPT-6.1 Sol",
    from: "anthropic/claude-opus-5-5",
    to: "anthropic/claude-sonnet-5-5",
    fromLabel: "Opus 5.5",
    toLabel: "Sonnet 5.5",
    kept: false,
    undone: false,
    ...overrides,
  };
}

const message = (id: string, at: number): AssistantMessage => ({
  id,
  role: "assistant",
  text: id,
  at,
});

describe("threadTrialRows", () => {
  it("keeps only the thread's cards and switches, oldest first, each named by its row", () => {
    const snapshot: TrialsSnapshot = {
      trials: [
        trial("t2", 300),
        trial("t1", 100),
        trial("other", 150, { thread: "assistant:astra" }),
        trial("chatless", 120, { thread: undefined }),
      ],
      switches: [switched("s1", 200), switched("s-other", 210, { thread: "session:abc" })],
    };
    const { rows, byRow } = threadTrialRows(snapshot, NOVA);
    expect(rows.map((row) => [row.id, row.role, row.at])).toEqual([
      ["trial-card:t1", "card", 100],
      ["trial-switch:s1", "card", 200],
      ["trial-card:t2", "card", 300],
    ]);
    expect(byRow.get("trial-card:t1")).toEqual({ kind: "trial", trial: snapshot.trials[1] });
    expect(byRow.get("trial-switch:s1")).toEqual({ kind: "switch", entry: snapshot.switches[0] });
    expect(rows.every((row) => isTrialRow(row.id))).toBe(true);
    expect(isTrialRow("assistant@5")).toBe(false);
  });

  it("merges into the thread by time, after ask cards are placed", () => {
    const { rows } = threadTrialRows(
      { trials: [trial("t1", 150), trial("t2", 400)], switches: [switched("s1", 250)] },
      NOVA,
    );
    const messages = [message("m1", 100), message("m2", 200), message("m3", 300)];
    const withAsks = withAskRows(messages, [
      { id: "q1", question: "Ship it?", replies: [], at: 220 } as never,
    ]);
    expect(insertByAt(withAsks, rows).map((row) => row.id)).toEqual([
      "m1",
      "trial-card:t1",
      "m2",
      "ask-card:q1",
      "trial-switch:s1",
      "m3",
      "trial-card:t2",
    ]);
  });

  it("leaves a thread with no trials as it was", () => {
    const messages = [message("m1", 100)];
    const { rows } = threadTrialRows({ trials: [], switches: [] }, NOVA);
    expect(insertByAt(messages, rows)).toEqual(messages);
  });
});

describe("the card", () => {
  it("shows its results in letter order", () => {
    expect(armsInOrder(trial("t1", 1)).map((arm) => arm.letter)).toEqual(["A", "B", "C"]);
  });

  it("asks before the pick and says what Isaac picked after it", () => {
    expect(trialHeader(trial("t1", 1))).toBe("Diagram · which is better?");
    expect(trialHeader(trial("t1", 1, { pick: "B" }))).toBe("Diagram · you picked B");
    expect(trialHeader(trial("t1", 1, { pick: "unsure" }))).toBe("Diagram · you couldn't tell");
  });

  it("says where a result without a preview stands", () => {
    expect(armStateText({ letter: "A", status: "running" })).toBe("Working on it");
    expect(armStateText({ letter: "A", status: "failed", error: "timeout" })).toBe("Didn't finish");
    expect(armStateText({ letter: "A", status: "done", preview: "x" })).toBeNull();
  });
});

describe("trialChoices", () => {
  it("offers each letter and Can't tell, enabled only where canPickTrial allows", () => {
    const choices = trialChoices(trial("t1", 1), undefined, true);
    expect(choices.map((choice) => [choice.pick, choice.label, choice.enabled])).toEqual([
      ["A", "A", true],
      ["B", "B", true],
      // Still running: not pickable yet.
      ["C", "C", false],
      ["unsure", "Can't tell", true],
    ]);
  });

  it("waits for two finished results", () => {
    const one = trial("t1", 1, {
      arms: [
        { letter: "A", status: "done", preview: "a" },
        { letter: "B", status: "running" },
        { letter: "C", status: "failed", error: "boom" },
      ],
    });
    expect(trialChoices(one, undefined, true).every((choice) => !choice.enabled)).toBe(true);
  });

  it("never lets a failed result be picked", () => {
    const failed = trial("t1", 1, {
      arms: [
        { letter: "A", status: "done", preview: "a" },
        { letter: "B", status: "done", preview: "b" },
        { letter: "C", status: "failed", error: "boom" },
      ],
    });
    expect(
      trialChoices(failed, undefined, true).find((choice) => choice.pick === "C")?.enabled,
    ).toBe(false);
  });

  it("disables every button offline or while this phone's pick is out, and marks the one sent", () => {
    expect(trialChoices(trial("t1", 1), undefined, false).some((choice) => choice.enabled)).toBe(
      false,
    );
    const sending = trialChoices(trial("t1", 1), "B", true);
    expect(sending.some((choice) => choice.enabled)).toBe(false);
    expect(sending.filter((choice) => choice.sending).map((choice) => choice.pick)).toEqual(["B"]);
  });

  it("has no buttons once picked", () => {
    expect(trialChoices(trial("t1", 1, { pick: "A" }), undefined, true)).toEqual([]);
  });
});

describe("the switch message", () => {
  it("says the agent's words with Undo, then what Undo did", () => {
    const entry = switched("s1", 1);
    expect(switchLine(entry)).toBe(entry.text);
    expect(canUndoSwitch(entry)).toBe(true);
    const undone = switched("s1", 1, { undone: true });
    expect(switchLine(undone)).toBe("Undone: back on Opus 5.5, trial on again");
    expect(canUndoSwitch(undone)).toBe(false);
  });

  it("offers no Undo when the agent kept its model", () => {
    expect(canUndoSwitch(switched("s1", 1, { kept: true }))).toBe(false);
  });
});

describe("frames", () => {
  it("are valid trial.pick and trial.undo frames from the phone", () => {
    const pick = trialPickFrame("t1", "unsure");
    expect(pick).toEqual({ t: "trial.pick", trial: "t1", pick: "unsure", surface: "phone" });
    expect(parseClientMessage(encode(pick)).ok).toBe(true);
    const undo = trialUndoFrame("s1");
    expect(undo).toEqual({ t: "trial.undo", switch: "s1" });
    expect(parseClientMessage(encode(undo)).ok).toBe(true);
  });
});
