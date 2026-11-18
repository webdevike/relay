import { describe, expect, test } from "bun:test";
import type { Registered } from "../src/core/Component.ts";
import { effective } from "../src/core/Settings.ts";

const agent = {
  id: "tiered",
  agent: {
    model: "m/base",
    candidates: ["m/base", "m/a", "m/b", "m/c"],
    thinking: "medium",
    system: "",
    trial: true,
    tiers: {
      by: "depth",
      default: "normal",
      levels: {
        quick: { model: "m/small", thinking: "low", maxSteps: 3, timeout: 60 },
        normal: { model: "m/base" },
        deep: {
          model: "m/big",
          thinking: "high",
          maxSteps: 30,
          candidates: ["m/big", "m/huge", "m/other"],
        },
      },
    },
  },
} as unknown as Registered;

describe("per-agent tiers", () => {
  test("a request field's value picks the tier; an absent, empty or unknown one does not break", () => {
    const resolved = effective(agent, {});
    expect(resolved.tier({ depth: "quick" })).toMatchObject({
      name: "quick",
      model: "m/small",
      thinking: "low",
      budget: { maxSteps: 3, timeout: 60 },
    });
    expect(resolved.tier({ depth: "deep" })).toMatchObject({
      name: "deep",
      model: "m/big",
      thinking: "high",
      budget: { maxSteps: 30 },
    });
    // A tier without its own thinking keeps the agent's; one without budget has none.
    expect(resolved.tier({})).toEqual({
      name: "normal",
      model: "m/base",
      thinking: "medium",
      arms: ["m/base", "m/a", "m/b"],
    });
    expect(resolved.tier({ depth: "" })?.name).toBe("normal");
    expect(resolved.tier({ depth: "bogus" })).toBeUndefined();
    expect(resolved.tier("not an object")?.name).toBe("normal");
  });

  test("a trial compares models only inside the request's tier", () => {
    const resolved = effective(agent, {});
    expect(resolved.tier({ depth: "deep" })!.arms).toEqual(["m/big", "m/huge", "m/other"]);
    expect(resolved.tier({ depth: "quick" })!.arms).toEqual(["m/small", "m/base", "m/a"]);
  });

  test("config.json model and thinking are one explicit choice for every tier; the budget stays the tier's", () => {
    const resolved = effective(agent, {
      components: { tiered: { model: "m/pinned", thinking: "off" } },
    });
    expect(resolved.tier({ depth: "deep" })).toMatchObject({
      model: "m/pinned",
      thinking: "off",
      budget: { maxSteps: 30 },
    });
  });

  test("an agent without tiers has none", () => {
    const plain = {
      ...agent,
      agent: { ...agent.agent, tiers: undefined },
    } as unknown as Registered;
    expect(effective(plain, {}).tier({ depth: "deep" })).toBeUndefined();
  });
});
