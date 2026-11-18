import { describe, expect, it } from "vitest";
import { joinModel, levelFor, splitModel } from "./assistantModel";

describe("registry model strings", () => {
  it("splits a thinking suffix off provider/id, and keeps a colon that belongs to the id", () => {
    expect(splitModel("anthropic/claude-opus-5-5:high")).toEqual({
      base: "anthropic/claude-opus-5-5",
      level: "high",
    });
    expect(splitModel("anthropic/claude-opus-5-5")).toEqual({
      base: "anthropic/claude-opus-5-5",
      level: undefined,
    });
    expect(splitModel("openrouter/some-model:free")).toEqual({
      base: "openrouter/some-model:free",
      level: undefined,
    });
  });

  it("joins a level back on, or leaves the bare model", () => {
    expect(joinModel("a/b", "low")).toBe("a/b:low");
    expect(joinModel("a/b", undefined)).toBe("a/b");
  });

  it("keeps the level across models, falls to the nearest lower one, and defaults to medium", () => {
    expect(levelFor(["low", "medium", "high"], "high")).toBe("high");
    expect(levelFor(["off", "low", "medium", "high"], "xhigh")).toBe("high");
    expect(levelFor(["high", "xhigh"], "low")).toBe("high");
    expect(levelFor(["low", "medium", "high"], undefined)).toBe("medium");
    expect(levelFor([], "high")).toBeUndefined();
  });
});
