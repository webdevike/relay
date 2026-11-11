import { describe, expect, it } from "vitest";
import type { AssistantMessage, GuestEntry } from "@relay/protocol";
import { guestRowKind, workTarget, workTime } from "./guests";

const penny = { id: "penny", title: "Penny" };
const work = (state: "working" | "done" | "failed", link?: string): GuestEntry => ({
  kind: "work",
  agent: penny,
  work: { id: "w1", title: "Find an SSD", state, startedAt: 1_000, ...(state === "working" ? {} : { endedAt: 135_000 }), ...(link === undefined ? {} : { link }) },
});
const row = (role: AssistantMessage["role"], guest?: GuestEntry): AssistantMessage => ({ id: "m", role, text: "", at: 1, ...(guest === undefined ? {} : { guest }) });

describe("guest rows", () => {
  it("draws joined/left lines, guest bubbles and work cards only from a host that sends guests", () => {
    expect(guestRowKind(row("status", { kind: "join", agent: penny }), true)).toBe("line");
    expect(guestRowKind(row("status", { kind: "leave", agent: penny }), true)).toBe("line");
    expect(guestRowKind(row("card", { kind: "say", agent: penny, text: "On it" }), true)).toBe("say");
    expect(guestRowKind(row("card", work("working")), true)).toBe("work");
    expect(guestRowKind(row("card", work("working")), false)).toBeNull();
    expect(guestRowKind(row("card"), true)).toBeNull();
    expect(guestRowKind(row("card", { kind: "work", agent: penny }), true)).toBeNull();
  });

  it("opens the guest's thread from a work card, or the thread its link names", () => {
    expect(workTarget(work("done"))).toEqual({ pathname: "/eva", params: { agent: "penny" } });
    expect(workTarget(work("done", "agent:astra"))).toEqual({ pathname: "/eva", params: { agent: "astra" } });
    expect(workTarget(work("done", "web:tab-7"))).toEqual({ pathname: "/eva", params: { agent: "penny" } });
  });

  it("shows how long the work has run, how long it took, and no time once it stopped", () => {
    expect(workTime(work("working").work!, 6_000)).toBe("0:05");
    expect(workTime(work("done").work!, 999_999)).toBe("2m 14s");
    expect(workTime(work("failed").work!, 999_999)).toBeNull();
  });
});
