import { describe, expect, it } from "vitest";
import { untagged, type AgentMessage, type AgentSession } from "@relay/protocol";
import {
  LAUNCH_ECHO,
  adoptLaunch,
  appendMessages,
  applyDelta,
  applySnapshot,
  clearLaunch,
  emptyAgentsData,
  failEcho,
  noteLaunch,
  noteSent,
  setConversation,
  type AgentsData,
} from "@/state/agents";
import { tagged } from "@/dictation/surface";
import { echoRows, settleEchoes, userEcho } from "./userEcho";

const session = (id: string): AgentSession => ({ id, provider: "omp", title: "Eva", projectPath: "/p", status: "idle", lastActivity: "", lastActivityAt: 1, canRespond: true });
const user = (id: string, text: string): AgentMessage => ({ id, role: "user", text: tagged(text), at: 2 });
const assistant = (id: string, text: string): AgentMessage => ({ id, role: "assistant", text, at: 3 });

/** The user bubbles the agent card draws for `key`: the transcript's, then the echoes after them. */
function bubbles(data: AgentsData, key: string): string[] {
  const rows = [...(data.conversations[key]?.messages ?? []), ...echoRows(data.echoes[key] ?? [])];
  return rows.filter((row) => row.role === "user").map((row) => untagged(row.text));
}

describe("a new session's first message", () => {
  it("shows the launch prompt at once, keeps it through registration, and leaves one bubble after the echo", () => {
    let data = applySnapshot(emptyAgentsData, 1, [session("old")]);
    // Sent: the bubble is in state before the host has even acked the start.
    data = noteLaunch(data, "plan the rework", 10);
    expect(bubbles(data, LAUNCH_ECHO)).toEqual(["plan the rework"]);

    // The session registers; the stand-in hands its bubble over before the transcript has anything.
    const registered = applyDelta(data, 2, [session("new")], undefined);
    expect(registered.ok).toBe(true);
    data = adoptLaunch(registered.data, "new");
    expect(data.echoes[LAUNCH_ECHO]).toBeUndefined();
    expect(bubbles(data, "new")).toEqual(["plan the rework"]);

    // The subscription answers with an empty transcript: omp has not taken the prompt yet.
    data = setConversation(data, "new", 1, []);
    expect(bubbles(data, "new")).toEqual(["plan the rework"]);

    // The echo: the transcript's row replaces the phone's, exactly one bubble.
    const echoed = appendMessages(data, "new", 2, [user("u1", "plan the rework")]);
    expect(echoed.ok).toBe(true);
    data = echoed.data;
    expect(data.echoes["new"]).toBeUndefined();
    expect(bubbles(data, "new")).toEqual(["plan the rework"]);
  });

  it("shows a typed first reply into a just-started session at once, and once after the echo", () => {
    let data = setConversation(applySnapshot(emptyAgentsData, 1, [session("new")]), "new", 1, []);
    data = noteSent(data, "new", tagged("hello there"), 10);
    expect(bubbles(data, "new")).toEqual(["hello there"]);
    data = appendMessages(data, "new", 2, [user("u1", "hello there"), assistant("a1", "hi")]).data;
    expect(bubbles(data, "new")).toEqual(["hello there"]);
    expect(data.echoes["new"]).toBeUndefined();
  });

  it("a launch the host refuses keeps its bubble, marked, until dismissed", () => {
    let data = noteLaunch(emptyAgentsData, "plan the rework", 10);
    data = failEcho(data, LAUNCH_ECHO, "host unreachable");
    expect(data.echoes[LAUNCH_ECHO]).toMatchObject([{ text: "plan the rework", error: "host unreachable" }]);
    // A session snapshot (no session for the launch) never drops it.
    data = applySnapshot(data, 2, [session("old")]);
    expect(bubbles(data, LAUNCH_ECHO)).toEqual(["plan the rework"]);
    data = clearLaunch(data);
    expect(data.echoes[LAUNCH_ECHO]).toBeUndefined();
  });

  it("a launch with nothing heard has no bubble", () => {
    expect(noteLaunch(emptyAgentsData, "", 10).echoes).toEqual({});
  });
});

describe("reply echoes", () => {
  const loaded = (messages: AgentMessage[] = []): AgentsData =>
    setConversation(applySnapshot(emptyAgentsData, 1, [session("s")]), "s", 1, messages);

  it("a refused reply keeps its bubble with the reason; the next send clears it", () => {
    let data = noteSent(loaded(), "s", tagged("ship it"), 10);
    data = failEcho(data, "s", "agent_not_found", 10);
    expect(data.echoes["s"]).toMatchObject([{ text: "ship it", error: "agent_not_found" }]);
    // A failed echo is never settled by rows arriving.
    data = appendMessages(data, "s", 2, [user("u1", "something else")]).data;
    expect(data.echoes["s"]).toHaveLength(1);
    data = noteSent(data, "s", tagged("ship it now"), 20);
    expect(data.echoes["s"]).toMatchObject([{ text: "ship it now" }]);
    expect(data.echoes["s"]?.[0]?.error).toBeUndefined();
  });

  it("slash commands show as the sent command, not as an echo", () => {
    const data = noteSent(loaded(), "s", "/handoff", 10);
    expect(data.sent["s"]).toBeDefined();
    expect(data.echoes["s"]).toBeUndefined();
  });

  it("the same words sent twice keep the second bubble until its own row lands", () => {
    let data = noteSent(loaded([user("u0", "yes")]), "s", tagged("yes"), 10);
    data = noteSent(data, "s", tagged("yes"), 11);
    data = appendMessages(data, "s", 2, [user("u1", "yes")]).data;
    expect(bubbles(data, "s")).toEqual(["yes", "yes", "yes"]);
    expect(data.echoes["s"]).toHaveLength(1);
    data = appendMessages(data, "s", 3, [user("u2", "yes")]).data;
    expect(data.echoes["s"]).toBeUndefined();
    expect(bubbles(data, "s")).toEqual(["yes", "yes", "yes"]);
  });

  it("words the host rewrote (a spoken command routed to its /command) still settle by count", () => {
    let data = noteSent(loaded(), "s", tagged("slash goal set ship it"), 10);
    data = appendMessages(data, "s", 2, [user("u1", "/goal set ship it")]).data;
    expect(data.echoes["s"]).toBeUndefined();
  });

  it("an older identical row never settles a new echo", () => {
    const data = noteSent(loaded([user("u0", "continue")]), "s", tagged("continue"), 10);
    expect(bubbles(data, "s")).toEqual(["continue", "continue"]);
  });

  it("a row the desktop tagged counts as the same words as the phone's echo", () => {
    let data = noteSent(loaded(), "s", tagged("ship it"), 10);
    const desktop: AgentMessage = { id: "u1", role: "user", text: "<surface>Mac Mini - Relay Desktop</surface>\nship it", at: 12 };
    data = appendMessages(data, "s", 2, [desktop]).data;
    expect(data.echoes["s"]).toBeUndefined();
    expect(bubbles(data, "s")).toEqual(["ship it"]);
  });

  it("a session that goes away takes its echoes with it", () => {
    const data = noteSent(loaded(), "s", tagged("hi"), 10);
    expect(applyDelta(data, 2, undefined, ["s"]).data.echoes["s"]).toBeUndefined();
  });

  it("settleEchoes returns the same list when nothing settled", () => {
    const echo = userEcho("hi", [], [], 1);
    if (echo === null) throw new Error("expected an echo");
    const list = [echo];
    expect(settleEchoes(list, [assistant("a", "x")])).toBe(list);
  });
});
