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
    await deliverDictation({ text: "hello", submit: true, skill: null }, send);
    expect(sent).toEqual([
      { kind: "text.insert", text: "hello" },
      { kind: "key.press", key: "return" },
    ]);
  });

  it("replies to the targeted agent, carrying the flick-up as submit instead of a Return", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    await deliverDictation({ text: "try again", submit: true, skill: null }, send);
    await deliverDictation({ text: "and also", submit: false, skill: null }, send);
    expect(sent).toEqual([
      { kind: "agent.reply", sessionId: "s1", text: "try again", submit: true },
      { kind: "agent.reply", sessionId: "s1", text: "and also", submit: false },
    ]);
  });

  it("prefixes the armed slash command verbatim", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    await deliverDictation({ text: "to staging", submit: true, skill: "/skill:deploy" }, send);
    expect(sent).toEqual([{ kind: "agent.reply", sessionId: "s1", text: "/skill:deploy to staging", submit: true }]);
  });

  it("falls back to inserting once the target is reset", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    resetDictationTarget();
    const { sent, send } = recorder();
    await deliverDictation({ text: "typed", submit: false, skill: null }, send);
    expect(sent).toEqual([{ kind: "text.insert", text: "typed" }]);
  });
});
