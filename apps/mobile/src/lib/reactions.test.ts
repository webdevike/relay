import { describe, expect, it } from "vitest";
import { QUICK_REACTIONS, ReactionEmoji } from "@relay/protocol";
import { bubbleReactionKey, MORE_REACTIONS, reactableRole, withReaction } from "./reactions";

describe("MORE_REACTIONS", () => {
  const all = MORE_REACTIONS.flatMap((section) => section.emoji);

  it("offers only emoji the host accepts", () => {
    for (const emoji of all) expect(ReactionEmoji.safeParse(emoji).success, emoji).toBe(true);
  });

  it("repeats neither itself nor the quick picks", () => {
    expect(new Set(all).size).toBe(all.length);
    for (const quick of QUICK_REACTIONS) expect(all).not.toContain(quick);
  });
});

describe("reactableRole", () => {
  it("is only Isaac's and the agent's bubbles", () => {
    expect(reactableRole("user")).toBe("user");
    expect(reactableRole("assistant")).toBe("assistant");
    for (const role of ["tool", "system", "card", "status", "error"]) expect(reactableRole(role)).toBeNull();
  });
});

describe("bubbleReactionKey", () => {
  it("keys a bubble by role and omp timestamp, truncated to ms", () => {
    expect(bubbleReactionKey({ role: "assistant", at: 1761500000123.7 })).toBe("assistant@1761500000123");
    expect(bubbleReactionKey({ role: "user", at: 42 })).toBe("user@42");
  });

  it("gives non-bubble rows and the phone's own pending rows none", () => {
    expect(bubbleReactionKey({ role: "tool", at: 1 })).toBeNull();
    expect(bubbleReactionKey({ role: "card", at: 1 })).toBeNull();
    expect(bubbleReactionKey({ role: "user", at: 1 }, true)).toBeNull();
  });
});

describe("withReaction", () => {
  const base = { "user@1": { emoji: "❤️", excerpt: "hi", at: 1 } };

  it("sets, replaces and clears without touching the input", () => {
    expect(withReaction(base, "assistant@2", "👍", "ok", 5)).toEqual({ ...base, "assistant@2": { emoji: "👍", excerpt: "ok", at: 5 } });
    expect(withReaction(base, "user@1", "😂", "hi", 6)).toEqual({ "user@1": { emoji: "😂", excerpt: "hi", at: 6 } });
    expect(withReaction(base, "user@1", null, "hi", 7)).toEqual({});
    expect(base).toEqual({ "user@1": { emoji: "❤️", excerpt: "hi", at: 1 } });
  });

  it("returns the same object when nothing changes", () => {
    expect(withReaction(base, "user@1", "❤️", "hi", 9)).toBe(base);
    expect(withReaction(base, "user@3", null, "", 9)).toBe(base);
  });
});
