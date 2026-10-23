import { describe, expect, it } from "vitest";
import type { AgentSession, AssistantAgent } from "@relay/protocol";
import { accountProfile, inProfile, normalizeProfile, orderAssistants, scopeOrder } from "./profile";

function session(id: string, extra: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: id,
    projectPath: `/p/${id}`,
    status: "idle",
    lastActivityAt: 0,
    canRespond: true,
    ...extra,
  } as AgentSession;
}

const sessions: Record<string, AgentSession> = {
  personal: session("personal", { account: { profile: "personal", email: "me@home" } }),
  work: session("work", { account: { profile: "work" } }),
  current: session("current", { account: { profile: "current" } }),
  missing: session("missing"),
};

describe("accountProfile", () => {
  it("reads personal as Personal, work and current as Work, and no account as neither", () => {
    expect(accountProfile({ profile: "personal", email: "me@home" })).toBe("personal");
    expect(accountProfile({ profile: "work" })).toBe("work");
    expect(accountProfile({ profile: "current" })).toBe("work");
    expect(accountProfile(undefined)).toBeNull();
  });
});

describe("normalizeProfile", () => {
  it("migrates the old empty (current) choice and unknown values to work", () => {
    expect(normalizeProfile("personal")).toBe("personal");
    expect(normalizeProfile("work")).toBe("work");
    expect(normalizeProfile("")).toBe("work");
    expect(normalizeProfile("current")).toBe("work");
    expect(normalizeProfile(undefined)).toBe("work");
  });
});

describe("inProfile / scopeOrder", () => {
  const order = ["personal", "work", "current", "missing", "gone"];

  it("Work keeps work, current and account-less sessions", () => {
    expect(scopeOrder(order, sessions, "work")).toEqual(["work", "current", "missing"]);
  });

  it("Personal keeps personal and account-less sessions", () => {
    expect(scopeOrder(order, sessions, "personal")).toEqual(["personal", "missing"]);
  });

  it("a session without an account shows in both", () => {
    const bare = session("bare");
    expect(inProfile(bare, "work")).toBe(true);
    expect(inProfile(bare, "personal")).toBe(true);
  });
});

describe("orderAssistants", () => {
  const agents: AssistantAgent[] = [
    { id: "astra", title: "Astra" },
    { id: "nova", title: "Nova" },
    { id: "polaris", title: "Polaris" },
  ];
  const running: Record<string, AgentSession> = {
    a: session("a", { kind: "assistant", assistant: "astra", account: { profile: "work" } }),
    n: session("n", { kind: "assistant", assistant: "nova", account: { profile: "personal" } }),
    p: session("p", { kind: "assistant", assistant: "polaris", account: { profile: "personal" } }),
    m: session("m", { account: { profile: "personal" } }),
  };

  it("leads with the agents on the chosen account, keeping registry order otherwise", () => {
    expect(orderAssistants(agents, running, "work").map((agent) => agent.id)).toEqual(["astra", "nova", "polaris"]);
    expect(orderAssistants(agents, running, "personal").map((agent) => agent.id)).toEqual(["nova", "polaris", "astra"]);
  });

  it("keeps the registry order when no assistant session reports an account", () => {
    expect(orderAssistants(agents, {}, "personal").map((agent) => agent.id)).toEqual(["astra", "nova", "polaris"]);
  });
});
