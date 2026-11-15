import { describe, expect, it } from "vitest";
import { encode, parseClientMessage, toggleReaction } from "@relay/protocol";
import { labelAnswerText, opensWidgetTraining, widgetLabelFrame } from "./widgetTraining";

describe("opensWidgetTraining", () => {
  it("opens the sheet when 🎯 goes on an assistant's reply in an assistant thread on a host that takes labels", () => {
    expect(opensWidgetTraining("assistant:nova", "assistant@5", toggleReaction(null, "🎯"), true)).toBe(true);
    expect(opensWidgetTraining("assistant:nova", "assistant@5", toggleReaction("❤️", "🎯"), true)).toBe(true);
  });

  it("leaves 🎯 a plain reaction everywhere else", () => {
    // Taking 🎯 back.
    expect(opensWidgetTraining("assistant:nova", "assistant@5", toggleReaction("🎯", "🎯"), true)).toBe(false);
    // Another emoji.
    expect(opensWidgetTraining("assistant:nova", "assistant@5", "❤️", true)).toBe(false);
    // Isaac's own bubble.
    expect(opensWidgetTraining("assistant:nova", "user@4", "🎯", true)).toBe(false);
    // A session transcript.
    expect(opensWidgetTraining("session:abc", "assistant@5", "🎯", true)).toBe(false);
    // A host without WIDGET_TRAINING_FEATURE.
    expect(opensWidgetTraining("assistant:nova", "assistant@5", "🎯", false)).toBe(false);
  });
});

describe("widgetLabelFrame", () => {
  it("is a valid widget.label from the phone, with the reply's excerpt", () => {
    const frame = widgetLabelFrame("assistant:nova", "assistant@5", "chart", "Revenue by month:\n\n| Jan | Feb |");
    expect(frame).toEqual({
      t: "widget.label",
      thread: "assistant:nova",
      message: "assistant@5",
      label: "chart",
      surface: "phone",
      excerpt: "Revenue by month: | Jan | Feb |",
    });
    const parsed = parseClientMessage(encode(frame));
    expect(parsed.ok).toBe(true);
  });

  it("cuts a long reply to the excerpt the host accepts", () => {
    const frame = widgetLabelFrame("assistant:nova", "assistant@5", "keep", "word ".repeat(400));
    expect(parseClientMessage(encode(frame)).ok).toBe(true);
  });
});

describe("labelAnswerText", () => {
  it("says whether the host saved it", () => {
    expect(labelAnswerText({ thread: "assistant:nova", message: "assistant@5", ok: true })).toBe("Saved for training");
    expect(labelAnswerText({ thread: "assistant:nova", message: "assistant@5", ok: false, error: "disk full" })).toBe("Label not saved");
  });
});
