import { describe, expect, it } from "vitest";
import type { RouterTurn } from "@relay/protocol";
import { routerRowOf, routerSheetOf } from "./routerRow";

const turn = (over: Partial<RouterTurn["decision"]> = {}, outcome?: RouterTurn["outcome"]): RouterTurn => ({
  decision: {
    v: 1,
    kind: "decision",
    id: "sr-1",
    at: "2026-11-17T20:00:00.000Z",
    assistant: "nova",
    mode: "shadow",
    agent: "web-researcher",
    confidence: 0.86,
    why: "wants sourced prices",
    alternatives: [{ agent: "web-researcher", p: 0.86 }],
    suggestedRequest: { question: "q" },
    threshold: 0.7,
    hinted: false,
    latencyMs: 300,
    prompt: "x",
    ...over,
  },
  ...(outcome === undefined ? {} : { outcome }),
});

describe("routerRowOf", () => {
  it("words Isaac's judged row: a match used, skipped with a reason, and none", () => {
    const used = routerRowOf({
      role: "user",
      router: turn({}, { v: 1, kind: "outcome", id: "sr-1", at: "x", used: true, usedAgents: ["web-researcher"] }),
    });
    expect(used?.label).toBe("Router: web-researcher · 0.86 · wants sourced prices · used");
    expect(used?.parts).toEqual({ head: "Router: web-researcher · 0.86", why: "wants sourced prices", mark: "used" });
    const skipped = routerRowOf({
      role: "user",
      router: turn({}, { v: 1, kind: "outcome", id: "sr-1", at: "x", used: false, usedAgents: [], skipReason: "wanted words" }),
    });
    expect(skipped?.parts.mark).toBe("skipped: wanted words");
    expect(routerRowOf({ role: "user", router: turn({ agent: "none" }) })?.label).toBe("Router: none");
  });

  it("has no line on other rows or rows the router never judged, and no mark while the turn runs", () => {
    expect(routerRowOf({ role: "status", router: turn() })).toBeNull();
    expect(routerRowOf({ role: "assistant", router: turn() })).toBeNull();
    expect(routerRowOf({ role: "user" })).toBeNull();
    expect(routerRowOf({ role: "user", router: turn() })?.parts.mark).toBeUndefined();
  });
});

describe("routerSheetOf", () => {
  it("lists the decision with the suggested request apart as JSON", () => {
    const sheet = routerSheetOf(turn());
    expect(sheet.request).toBe(JSON.stringify({ question: "q" }, null, 2));
    expect(sheet.rows.map(([label]) => label)).not.toContain("Suggested request");
    expect(new Map(sheet.rows).get("Outcome")).toBe("turn still running");
    expect(routerSheetOf(turn({ suggestedRequest: undefined })).request).toBeNull();
  });
});
