import { describe, expect, it } from "vitest";
import { notificationTarget } from "./notification-target";

describe("notificationTarget", () => {
  it("opens the thread of the agent an assistant push names", () => {
    expect(notificationTarget({ assistant: true, agent: "nova" })).toEqual({ pathname: "/eva", params: { agent: "nova" } });
    expect(notificationTarget({ assistant: true, agent: "astra" })).toEqual({ pathname: "/eva", params: { agent: "astra" } });
  });

  it("goes nowhere for an assistant push without an agent", () => {
    expect(notificationTarget({ assistant: true })).toBeNull();
    expect(notificationTarget({ assistant: true, agent: "" })).toBeNull();
    expect(notificationTarget({ assistant: true, agent: 3 })).toBeNull();
  });

  it("opens the session for a session notification", () => {
    expect(notificationTarget({ sessionId: "s1" })).toEqual({ pathname: "/agents", params: { sessionId: "s1" } });
  });

  it("ignores anything else", () => {
    expect(notificationTarget({})).toBeNull();
    expect(notificationTarget({ dropId: "d1" })).toBeNull();
    expect(notificationTarget({ assistant: "yes", agent: "nova" })).toBeNull();
  });
});
