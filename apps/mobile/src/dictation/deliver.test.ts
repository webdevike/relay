import { afterEach, describe, expect, it } from "vitest";
import type { Command } from "@relay/protocol";
import { deliverDictation, resetDictationTarget, setDictationTarget } from "./deliver";

function recorder(): { sent: Command[]; send: (cmd: Command) => Promise<void> } {
  const sent: Command[] = [];
  return {
    sent,
    send: (cmd) => {
      sent.push(cmd);
      return Promise.resolve();
    },
  };
}

afterEach(() => {
  resetDictationTarget();
});

describe("deliverDictation", () => {
  it("inserts, then presses Return on submit, by default", async () => {
    const { sent, send } = recorder();
    await deliverDictation({ text: "hello", submit: true }, send);
    expect(sent).toEqual([
      { kind: "text.insert", text: "hello" },
      { kind: "key.press", key: "return" },
    ]);
  });

  it("replies to the targeted agent, carrying the flick-up as submit instead of a Return", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    await deliverDictation({ text: "try again", submit: true }, send);
    await deliverDictation({ text: "and also", submit: false }, send);
    expect(sent).toEqual([
      { kind: "agent.reply", sessionId: "s1", text: "try again", submit: true },
      { kind: "agent.reply", sessionId: "s1", text: "and also", submit: false },
    ]);
  });

  it("falls back to inserting once the target is reset", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    resetDictationTarget();
    const { sent, send } = recorder();
    await deliverDictation({ text: "typed", submit: false }, send);
    expect(sent).toEqual([{ kind: "text.insert", text: "typed" }]);
  });
});
