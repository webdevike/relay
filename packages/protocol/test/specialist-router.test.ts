import { describe, expect, it } from "vitest";
import {
  ROUTER_ENTRY_TYPE,
  routerByUserMessage,
  routerDetail,
  routerLine,
  routerParts,
  routerRecordOf,
  type RouterDecision,
  type RouterOutcome,
} from "../src/specialist-router";
import { AssistantMessage } from "../src/index";

const decision = (over: Partial<RouterDecision> = {}): RouterDecision => ({
  v: 1,
  kind: "decision",
  id: "sr-1",
  at: "2026-11-17T20:00:00.000Z",
  assistant: "nova",
  mode: "shadow",
  agent: "web-researcher",
  confidence: 0.857,
  why: "asks for current prices with sources",
  alternatives: [
    { agent: "web-researcher", p: 0.857 },
    { agent: "none", p: 0.1 },
  ],
  suggestedRequest: { question: "2TB USB4 SSD under $200", depth: "quick" },
  threshold: 0.7,
  hinted: false,
  latencyMs: 412,
  prompt: "Which 2TB USB4 SSD",
  ...over,
});

const outcome = (over: Partial<RouterOutcome> = {}): RouterOutcome => ({
  v: 1,
  kind: "outcome",
  id: "sr-1",
  at: "2026-11-17T20:01:00.000Z",
  used: true,
  usedAgents: ["web-researcher"],
  ...over,
});

const custom = (id: string, data: unknown, customType = ROUTER_ENTRY_TYPE) => ({
  type: "custom",
  id,
  parentId: "p",
  timestamp: "2026-11-17T20:00:00.000Z",
  customType,
  data,
});
const user = (id: string, timestamp = 1_794_950_000_000, text = "hi") => ({
  type: "message",
  id,
  parentId: "p",
  timestamp: "2026-11-17T20:00:00.000Z",
  message: { role: "user", content: text, timestamp },
});
const reply = (id: string) => ({
  type: "message",
  id,
  parentId: "p",
  message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
});

describe("routerByUserMessage", () => {
  it("puts a decision on the first user message after it, past omp's own custom entries, and joins the outcome by id", () => {
    const routed = routerByUserMessage([
      custom("c1", decision()),
      custom("c2", { text: "Today is 2026-11-17" }, "date-reminder"),
      user("u1", 111),
      reply("a1"),
      custom("c3", outcome()),
    ]);
    expect([...routed.keys()]).toEqual(["u1"]);
    expect(routed.get("u1")).toEqual({ decision: decision(), at: 111, outcome: outcome() });
  });

  it("leaves the outcome off while the turn runs (or after a crash)", () => {
    const routed = routerByUserMessage([custom("c1", decision()), user("u1"), reply("a1")]);
    expect(routed.get("u1")?.outcome).toBeUndefined();
    expect(routed.get("u1")?.decision.id).toBe("sr-1");
  });

  it("gives each decision its own message, never a later one, and only user messages", () => {
    const routed = routerByUserMessage([
      user("u0"),
      custom("c1", decision({ id: "sr-a" })),
      reply("a0"),
      user("u1"),
      user("u2"),
      custom("c2", decision({ id: "sr-b", agent: "none", noneReason: "chat" })),
      user("u3"),
      custom("c3", outcome({ id: "sr-b", used: false, usedAgents: [] })),
      custom("c4", outcome({ id: "sr-a" })),
    ]);
    expect([...routed.keys()]).toEqual(["u1", "u3"]);
    expect(routed.get("u1")?.decision.id).toBe("sr-a");
    expect(routed.get("u1")?.outcome?.used).toBe(true);
    expect(routed.get("u3")?.decision.agent).toBe("none");
    expect(routed.get("u3")?.outcome?.used).toBe(false);
  });

  it("lets a newer decision replace one that never reached a message", () => {
    const routed = routerByUserMessage([
      custom("c1", decision({ id: "sr-old" })),
      custom("c2", decision({ id: "sr-new" })),
      user("u1"),
    ]);
    expect(routed.get("u1")?.decision.id).toBe("sr-new");
  });

  it("ignores junk: unknown v, bad shapes, other custom types, non-objects, an outcome with no decision", () => {
    const routed = routerByUserMessage([
      null,
      "text",
      custom("c0", { ...decision(), v: 2 }),
      custom("c1", { ...decision(), confidence: "high" }),
      custom("c2", { kind: "decision" }),
      custom("c3", decision({ id: "sr-x" }), "eva.other"),
      { type: "custom_message", customType: ROUTER_ENTRY_TYPE, data: decision() },
      custom("c4", outcome({ id: "sr-ghost" })),
      user("u1"),
    ]);
    expect(routed.size).toBe(0);
  });

  it("keeps a decision whose optional fields are malformed, dropping only those", () => {
    const record = routerRecordOf(
      custom("c1", { ...decision(), noneReason: "bored", suggestedRequest: "x", alternatives: 3 }),
    );
    expect(record?.kind).toBe("decision");
    if (record?.kind !== "decision") return;
    expect(record.noneReason).toBeUndefined();
    expect(record.suggestedRequest).toBeUndefined();
    expect(record.alternatives).toEqual([]);
  });

  it("rides on an assistant row, and a bad router never breaks the row", () => {
    const row = { id: "u1", role: "user", text: "hi", at: 1 };
    expect(AssistantMessage.parse({ ...row, router: { decision: decision() } }).router?.decision.agent).toBe(
      "web-researcher",
    );
    expect(AssistantMessage.parse({ ...row, router: { decision: { v: 9 } } }).router).toBeUndefined();
  });
});

describe("routerLine", () => {
  it("matches: agent, confidence to 2 decimals and the why on one line", () => {
    expect(routerLine(decision({ why: "asks for\n current prices" }))).toBe(
      "Router: web-researcher · 0.86 · asks for current prices",
    );
    expect(routerParts(decision())).toEqual({
      head: "Router: web-researcher · 0.86",
      why: "asks for current prices with sources",
    });
  });

  it("none and errors", () => {
    expect(routerLine(decision({ agent: "none", confidence: 0.9, noneReason: "chat", why: "small talk" }))).toBe(
      "Router: none",
    );
    expect(
      routerLine(decision({ agent: "none", confidence: 0, error: "timeout", why: "router skipped: timeout" })),
    ).toBe("Router: skipped · timeout");
  });

  it("marks a match used, or skipped with or without a reason, after the turn", () => {
    expect(routerLine(decision(), outcome())).toBe(
      "Router: web-researcher · 0.86 · asks for current prices with sources · used",
    );
    expect(routerLine(decision(), outcome({ used: false, usedAgents: [], skipReason: "Isaac wanted my take" }))).toBe(
      "Router: web-researcher · 0.86 · asks for current prices with sources · skipped: Isaac wanted my take",
    );
    expect(routerLine(decision(), outcome({ used: false, usedAgents: ["diagram"] }))).toBe(
      "Router: web-researcher · 0.86 · asks for current prices with sources · skipped",
    );
    expect(routerParts(decision(), outcome({ used: false, usedAgents: [] })).mark).toBe("skipped");
  });

  it("marks none only when the assistant used a specialist the router did not pick", () => {
    const none = decision({ agent: "none", confidence: 0.8, noneReason: "no-fit" });
    expect(routerLine(none, outcome({ used: false, usedAgents: ["prop-render"] }))).toBe(
      "Router: none · used prop-render",
    );
    expect(routerLine(none, outcome({ used: false, usedAgents: [] }))).toBe("Router: none");
    const failed = decision({ agent: "none", confidence: 0, error: "jev 503" });
    expect(routerLine(failed, outcome({ used: false, usedAgents: ["diagram"] }))).toBe(
      "Router: skipped · jev 503 · used diagram",
    );
  });

  it("has no mark while the turn runs, and never an em dash", () => {
    expect(routerParts(decision()).mark).toBeUndefined();
    for (const line of [
      routerLine(decision(), outcome()),
      routerLine(decision({ agent: "none" })),
      routerLine(decision({ agent: "none", error: "timeout" })),
    ])
      expect(line).not.toMatch(/\u2014/);
  });
});

describe("routerDetail", () => {
  it("lists the whole decision and its outcome", () => {
    const rows = new Map(routerDetail({ decision: decision({ mode: "live", hinted: true }), outcome: outcome() }));
    expect(rows.get("Agent")).toBe("web-researcher");
    expect(rows.get("Confidence")).toBe("0.86");
    expect(rows.get("Alternatives")).toBe("web-researcher 0.86, none 0.10");
    expect(rows.get("Suggested request")).toBe(JSON.stringify(decision().suggestedRequest, null, 2));
    expect(rows.get("Mode")).toBe("live");
    expect(rows.get("Hinted")).toBe("yes");
    expect(rows.get("Threshold")).toBe("0.70");
    expect(rows.get("Latency")).toBe("412 ms");
    expect(rows.get("Used")).toBe("yes");
    expect(rows.get("Used agents")).toBe("web-researcher");
  });

  it("says a running turn has no outcome yet, and shows none reasons and errors", () => {
    const rows = new Map(
      routerDetail({ decision: decision({ agent: "none", noneReason: "missing-inputs", error: "timeout" }) }),
    );
    expect(rows.get("None reason")).toBe("missing-inputs");
    expect(rows.get("Error")).toBe("timeout");
    expect(rows.get("Outcome")).toBe("turn still running");
  });
});
