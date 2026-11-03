import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@relay/protocol";
import { backgroundOf } from "./background";

const row = (role: AssistantMessage["role"], text: string): AssistantMessage => ({ id: "m", role, text, at: 1 });

describe("backgroundOf", () => {
  it("reads the host's job lines (status rows) and another agent's hand-offs (user rows)", () => {
    expect(backgroundOf(row("status", "[From Nova's background jobs] Heartbeat: 2 new.\n[gmail] A (x)\n[work] B (https://linear.app/x)"))).toMatchObject({
      kind: "heartbeat",
      from: "Nova",
      count: 2,
      sources: [
        { source: "gmail", count: 1 },
        { source: "work", count: 1 },
      ],
    });
    expect(backgroundOf(row("user", "[From Astra's background jobs] Auto-work ENG-6543: self-review clean."))).toMatchObject({
      kind: "event",
      icon: "robot",
      summary: "Astra · Auto-work ENG-6543: self-review clean",
    });
    expect(backgroundOf(row("user", 'Canvas "Demo" wrap-up: moved the chart. Next, the legend.'))).toMatchObject({ kind: "event", icon: "board" });
  });

  it("leaves Isaac's turns, the agent's replies and cards as they are", () => {
    expect(backgroundOf(row("user", "Can you book the oil change?"))).toBeNull();
    expect(backgroundOf(row("assistant", "[From Nova's background jobs] quoted back"))).toBeNull();
    expect(backgroundOf(row("card", "Live canvas started on \"Demo\""))).toBeNull();
    expect(backgroundOf(row("status", "Working on it"))).toBeNull();
  });
});
