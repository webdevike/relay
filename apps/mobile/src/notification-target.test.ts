import { describe, expect, it } from "vitest";
import { notificationCall, notificationTarget } from "./notification-target";

describe("notificationTarget", () => {
  it("opens the thread of the agent an assistant push names", () => {
    expect(notificationTarget({ assistant: true, agent: "nova" })).toEqual({
      pathname: "/eva",
      params: { agent: "nova" },
    });
    expect(notificationTarget({ assistant: true, agent: "astra" })).toEqual({
      pathname: "/eva",
      params: { agent: "astra" },
    });
  });

  it("goes nowhere for an assistant push without an agent", () => {
    expect(notificationTarget({ assistant: true })).toBeNull();
    expect(notificationTarget({ assistant: true, agent: "" })).toBeNull();
    expect(notificationTarget({ assistant: true, agent: 3 })).toBeNull();
  });

  it("opens the session for a session notification", () => {
    expect(notificationTarget({ sessionId: "s1" })).toEqual({
      pathname: "/agents",
      params: { sessionId: "s1" },
    });
  });

  it("opens the meeting a recording or notes push names", () => {
    expect(notificationTarget({ meeting: "6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e10" })).toEqual({
      pathname: "/meetings/[id]",
      params: { id: "6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e10" },
    });
    expect(notificationTarget({ meeting: "" })).toBeNull();
  });

  it("ignores anything else", () => {
    expect(notificationTarget({})).toBeNull();
    expect(notificationTarget({ dropId: "d1" })).toBeNull();
    expect(notificationTarget({ assistant: "yes", agent: "nova" })).toBeNull();
  });
});

describe("notificationCall", () => {
  it("answers an assistant's ring, which also carries the thread's assistant fields", () => {
    expect(notificationCall({ id: "call:call-1", callRequest: "call-1", agent: "nova", assistant: true })).toEqual({ agent: "nova", request: "call-1" });
  });

  it("is no ring for any other push or a ring missing its agent", () => {
    expect(notificationCall({ assistant: true, agent: "nova" })).toBeNull();
    expect(notificationCall({ callRequest: "call-1" })).toBeNull();
    expect(notificationCall({ callRequest: "", agent: "nova" })).toBeNull();
    expect(notificationCall({ withdraw: "call:call-1" })).toBeNull();
  });
});
