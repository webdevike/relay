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
    await deliverDictation({ text: "hello", submit: true, skill: null, images: [] }, send);
    expect(sent).toEqual([
      { kind: "text.insert", text: "hello" },
      { kind: "key.press", key: "return" },
    ]);
  });

  it("replies to the targeted agent, carrying the flick-up as submit instead of a Return", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    await deliverDictation({ text: "try again", submit: true, skill: null, images: [] }, send);
    await deliverDictation({ text: "and also", submit: false, skill: null, images: [] }, send);
    expect(sent).toEqual([
      { kind: "agent.reply", sessionId: "s1", text: "try again", submit: true },
      { kind: "agent.reply", sessionId: "s1", text: "and also", submit: false },
    ]);
  });

  it("prefixes the armed slash command verbatim", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    await deliverDictation({ text: "to staging", submit: true, skill: "/skill:deploy", images: [] }, send);
    expect(sent).toEqual([{ kind: "agent.reply", sessionId: "s1", text: "/skill:deploy to staging", submit: true }]);
  });

  it("a command picked without text goes out on its own", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    await deliverDictation({ text: "", submit: true, skill: "/goal show", images: [] }, send);
    expect(sent).toEqual([{ kind: "agent.reply", sessionId: "s1", text: "/goal show", submit: true }]);
  });

  it("falls back to inserting once the target is reset", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    resetDictationTarget();
    const { sent, send } = recorder();
    await deliverDictation({ text: "typed", submit: false, skill: null, images: [] }, send);
    expect(sent).toEqual([{ kind: "text.insert", text: "typed" }]);
  });

  it("an agent reply carries the attached images without their pixel sizes", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    const shot = { mimeType: "image/jpeg" as const, data: "abc", width: 4, height: 3 };
    await deliverDictation({ text: "look", submit: true, skill: null, images: [shot] }, send);
    expect(sent).toEqual([{ kind: "agent.reply", sessionId: "s1", text: "look", submit: true, images: [{ mimeType: "image/jpeg", data: "abc" }] }]);
  });

  it("images alone go out as a submitted reply with empty text", async () => {
    setDictationTarget({ kind: "agent", sessionId: "s1" });
    const { sent, send } = recorder();
    const shot = { mimeType: "image/png" as const, data: "xyz", width: 1, height: 1 };
    await deliverDictation({ text: "", submit: true, skill: null, images: [shot] }, send);
    expect(sent).toEqual([{ kind: "agent.reply", sessionId: "s1", text: "", submit: true, images: [{ mimeType: "image/png", data: "xyz" }] }]);
  });

  it("the insert target has nowhere for images: only the text is typed", async () => {
    const { sent, send } = recorder();
    const shot = { mimeType: "image/jpeg" as const, data: "abc", width: 4, height: 3 };
    await deliverDictation({ text: "typed", submit: false, skill: null, images: [shot] }, send);
    expect(sent).toEqual([{ kind: "text.insert", text: "typed" }]);
  });
});
