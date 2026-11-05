import { describe, expect, it } from "vitest";
import type { AgentMessage, AssistantMessage } from "@relay/protocol";
import { buildTurns } from "@evaos/chat-core/turns";
import { agentTurnRows, assistantTurnRows } from "./rows";

const T0 = 1_800_000_000_000;
const say = (id: string, role: AssistantMessage["role"], text: string, at: number, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({ id, role, text, at, ...extra });
const none = (): boolean => false;

describe("assistantTurnRows", () => {
  it("keeps Isaac's messages and the assistant's replies at their position in the list", () => {
    const rows = assistantTurnRows(
      [say("a", "status", "Job started", T0), say("b", "user", "hi", T0 + 1), say("c", "card", "", T0 + 2), say("d", "assistant", "Hello", T0 + 3), say("e", "error", "x", T0 + 4)],
      none,
      false,
    );
    expect(rows.map((r) => [r.index, r.id, r.role, r.at])).toEqual([
      [1, "b", "user", T0 + 1],
      [3, "d", "assistant", T0 + 3],
    ]);
  });

  it("puts the replies token the host cut back, so tap-to-answer replies flag the turn", () => {
    const rows = assistantTurnRows([say("u", "user", "x", T0), say("a", "assistant", "Pick one.", T0 + 1, { replies: ["Yes", "No"] })], none, false);
    expect(rows[1]?.text).toBe("Pick one.\n[[replies: Yes | No]]");
    expect(buildTurns(rows, undefined)[0]?.flag).toBe("ask");
  });

  it("leaves out rows that are not the host's (the echo of a turn in flight, rows this phone added)", () => {
    const rows = assistantTurnRows([say("u", "user", "x", T0), say("pending-turn", "user", "y", T0 + 5), say("local:1", "assistant", "z", T0 + 6)], (m) => m.id === "pending-turn" || m.id.startsWith("local:"), false);
    expect(rows.map((r) => r.id)).toEqual(["u"]);
  });

  it("adds an ask card nobody answered after the last row, flagging the last turn", () => {
    const list = [say("u", "user", "do it", T0), say("a", "assistant", "Working.", T0 + 1)];
    const rows = assistantTurnRows(list, none, true);
    expect(rows.at(-1)).toMatchObject({ index: 2, role: "ask" });
    expect(buildTurns(rows, undefined)[0]?.flag).toBe("ask");
    expect(buildTurns(assistantTurnRows(list, none, false), undefined)[0]?.flag).toBeNull();
  });

  it("does not count another agent's hand-off or a tapback as Isaac's turn", () => {
    const rows = assistantTurnRows([say("u", "user", "[Isaac reacted 👍 to your message: \"ok\"]", T0)], none, false);
    expect(rows.every((r) => r.role !== "user" || !r.text.includes("reacted"))).toBe(true);
  });
});

describe("agentTurnRows", () => {
  const msg = (id: string, role: AgentMessage["role"], text: string, at: number, extra: Partial<AgentMessage> = {}): AgentMessage => ({ id, role, text, at, ...extra });
  it("keeps user and assistant rows, with streaming, and skips tools, system rows and echoes", () => {
    const rows = agentTurnRows([msg("u", "user", "go", T0), msg("t", "tool", "read", T0 + 1), msg("a", "assistant", "done?", T0 + 2, { streaming: true }), msg("s", "system", "x", T0 + 3), msg("echo", "user", "later", T0 + 4)], (m) => m.id === "echo");
    expect(rows.map((r) => [r.index, r.id, r.streaming])).toEqual([
      [0, "u", undefined],
      [2, "a", true],
    ]);
  });
});
