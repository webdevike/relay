import { describe, expect, it } from "vitest";
import { answerText, stillAsking } from "../src/answer-context";

const ask = {
  source: "replies" as const,
  question: "Paste it here or read it on the Mini?",
  at: 100,
};

describe("stillAsking", () => {
  it("stays open with no later turn of his", () => {
    expect(
      stillAsking(ask, [
        { role: "assistant", text: "Paste it here or read it on the Mini?", at: 100 },
      ]),
    ).toBe(true);
  });

  it("closes on any later user turn, typed words included", () => {
    expect(
      stillAsking(ask, [
        { role: "user", text: "Okay nvm", at: 150 },
        { role: "assistant", text: "Ok.", at: 160 },
      ]),
    ).toBe(false);
  });

  it("ignores earlier turns and rows without a time", () => {
    expect(
      stillAsking(ask, [
        { role: "user", text: "Hi", at: 50 },
        { role: "user", text: "Echo" },
      ]),
    ).toBe(true);
  });

  it("keeps it open for an answer tagged to a different question, closes it for its own", () => {
    const other = answerText("Skip it", "Another question?", true);
    expect(stillAsking(ask, [{ role: "user", text: other, at: 150 }])).toBe(true);
    expect(
      stillAsking(ask, [
        { role: "user", text: answerText("Skip it", ask.question, true), at: 150 },
      ]),
    ).toBe(false);
  });

  it("never closes a card's or a session's ask from the thread", () => {
    expect(
      stillAsking({ ...ask, source: "session" }, [{ role: "user", text: "ok", at: 150 }]),
    ).toBe(true);
    expect(stillAsking({ ...ask, source: "ask" }, [{ role: "user", text: "ok", at: 150 }])).toBe(
      true,
    );
  });
});
