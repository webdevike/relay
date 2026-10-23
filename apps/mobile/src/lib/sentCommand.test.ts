import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentSession } from "@relay/protocol";
import { applyDelta, applySnapshot, appendMessages, dropSent, emptyAgentsData, noteSent, setConversation, type AgentsData } from "@/state/agents";
import { SENT_COMMAND_TIMEOUT_MS, SENT_HANDOFF_TIMEOUT_MS, sentCommand, sentRemaining, settleOnMessages, settleOnSession } from "./sentCommand";
import { commandWord } from "./slash";

const idle: AgentSession = { id: "s", provider: "omp", title: "Eva", projectPath: "/p", status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true };
const row = (role: AgentMessage["role"], text = "x"): AgentMessage => ({ id: `${role}-${text}`, role, text, at: 2 });

/** A session loaded with its conversation, as the agent screen has it. */
function loaded(session: AgentSession = idle): AgentsData {
  return setConversation(applySnapshot(emptyAgentsData, 1, [session]), "s", 1, []);
}

describe("commandWord", () => {
  it("reads the command a text starts with, and not a pasted path", () => {
    expect(commandWord("/skill:review the diff")).toBe("/skill:review");
    expect(commandWord("/skill:agents/hallmark audit")).toBe("/skill:agents/hallmark");
    expect(commandWord(" /handoff")).toBe("/handoff");
    expect(commandWord("/Users/ike/notes.md is broken")).toBeUndefined();
    expect(commandWord("hi /goal")).toBeUndefined();
  });
});

describe("sentCommand", () => {
  it("notes a slash command with the session's status and goal at the send", () => {
    const sent = sentCommand("/skill:review the diff ", { ...idle, goal: { objective: "x", paused: false, tokensUsed: 0 } }, 10);
    expect(sent).toMatchObject({ text: "/skill:review the diff", name: "/skill:review", at: 10, handoff: false, status: "idle" });
    expect(sentCommand("/handoff focus on tests", idle, 10)?.handoff).toBe(true);
    expect(sentCommand("<surface>iPhone - Relay</surface>\nhello", idle, 10)).toBeNull();
  });

  it("clears an ordinary command on a status change, a goal change, a handoff, or any new row", () => {
    const sent = sentCommand("/goal pause", { ...idle, status: "working", goal: { objective: "x", paused: false, tokensUsed: 5 } }, 1);
    if (sent === null) throw new Error("not a command");
    const working = { ...idle, status: "working" as const, goal: { objective: "x", paused: false, tokensUsed: 5 } };
    expect(settleOnSession(sent, working)).toBe(sent);
    expect(settleOnSession(sent, { ...working, status: "idle" })).toBeNull();
    expect(settleOnSession(sent, { ...working, goal: { objective: "x", paused: true, tokensUsed: 5 } })).toBeNull();
    expect(settleOnSession(sent, { ...working, handingOff: true })).toBeNull();
    expect(settleOnMessages(sent, [])).toBe(sent);
    expect(settleOnMessages(sent, [row("user", "/skill:review")])).toBeNull();
  });

  it("times out: an ordinary command after seconds, a handoff after minutes", () => {
    const command = sentCommand("/rename x", idle, 0);
    const handoff = sentCommand("/handoff", idle, 0);
    if (command === null || handoff === null) throw new Error("not a command");
    expect(sentRemaining(command, SENT_COMMAND_TIMEOUT_MS)).toBe(0);
    expect(sentRemaining(handoff, SENT_COMMAND_TIMEOUT_MS)).toBeGreaterThan(0);
    expect(sentRemaining(handoff, SENT_HANDOFF_TIMEOUT_MS)).toBe(0);
  });
});

describe("handoff flag lifecycle", () => {
  it("shows from the send, through the session's own handoff, until it goes off", () => {
    let data = noteSent(loaded(), "s", "/handoff", 5);
    expect(data.sent["s"]?.handoff).toBe(true);
    // The status the bridge re-reports right after the submit changes nothing.
    data = applyDelta(data, 2, [{ ...idle, lastActivityAt: 3 }], undefined).data;
    expect(data.sent["s"]?.sawHandoff).toBe(false);
    data = applyDelta(data, 3, [{ ...idle, handingOff: true }], undefined).data;
    expect(data.sent["s"]?.sawHandoff).toBe(true);
    // Assistant text from elsewhere does not end it; the handoff going off does.
    data = appendMessages(data, "s", 2, [row("assistant")]).data;
    expect(data.sent["s"]).toBeDefined();
    data = applyDelta(data, 4, [idle], undefined).data;
    expect(data.sent["s"]).toBeUndefined();
  });

  it("ends on a system row: the compaction notice, or the host refusing a busy handoff", () => {
    let data = noteSent(loaded({ ...idle, status: "working" }), "s", "/handoff", 5);
    data = appendMessages(data, "s", 2, [row("system", "Handoff not started: wait for the current response to finish or stop it first.")]).data;
    expect(data.sent["s"]).toBeUndefined();
  });

  it("is dropped when the host refuses the reply, but only for that send", () => {
    const data = noteSent(loaded(), "s", "/handoff", 5);
    expect(dropSent(data, "s", 4)).toBe(data);
    expect(dropSent(data, "s", 5).sent["s"]).toBeUndefined();
  });
});

describe("noteSent", () => {
  it("replaces a pending command with the next one, clears it on plain text, and goes with its session", () => {
    let data = noteSent(loaded(), "s", "/skill:review", 1);
    data = noteSent(data, "s", "/goal pause", 2);
    expect(data.sent["s"]?.name).toBe("/goal");
    expect(noteSent(data, "s", "never mind", 3).sent["s"]).toBeUndefined();
    // Plain text has no command to note (its bubble is an echo, lib/userEcho.ts).
    expect(noteSent(loaded(), "s", "hello", 3).sent).toEqual({});
    expect(applyDelta(data, 2, undefined, ["s"]).data.sent["s"]).toBeUndefined();
  });
});
