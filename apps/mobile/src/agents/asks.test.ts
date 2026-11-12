import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAsk, AssistantSnapshot, Command, OpenAsk } from "@relay/protocol";
import { CommandQueue, type CommandReport } from "@/connection/commands";
import { cardAskKey, openAskKey } from "@/lib/openAsks";
import { useAgentsStore } from "@/state/agents";
import { useAssistantStore } from "@/state/assistant";
import { answerAsk, dismissAsk, retryAsk } from "./asks";

/** The real queue behind a fake socket: what went on the wire, and its acks. */
const wire: { sent: { id: string; cmd: Command }[]; queue: CommandQueue } = { sent: [], queue: new CommandQueue() };

vi.mock("@/connection", () => ({
  sendCommand: (cmd: Command) =>
    wire.queue.enqueue(cmd, (message) => {
      if (message.t === "cmd") wire.sent.push({ id: message.id, cmd: message.cmd });
    }),
  onCommandReport: (listener: (report: CommandReport) => void) => wire.queue.onReport(listener),
}));

const card: AgentAsk = { id: "k1", questions: [{ id: "q", question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }] };
const openCard: OpenAsk = { id: "0000000a", source: "ask", label: "Ship?", question: "Ship?", replies: ["Yes", "No"], at: 1, sessionId: "S", askId: "k1" };
const chipAsk: OpenAsk = { id: "0000000b", source: "replies", label: "Lunch?", question: "Lunch?", replies: ["Yes", "No"], at: 2, messageId: "m1" };
const snapshot = (asks: OpenAsk[]): AssistantSnapshot => ({ rev: 1, busy: false, sessionId: "S", messages: [], asks });

const kinds = () => wire.sent.map((frame) => frame.cmd.kind);
const record = (key: string) => useAgentsStore.getState().askRecords[key];
/** Lets the sends settle (no time passes). */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  wire.sent = [];
  useAgentsStore.setState({ asks: { S: card }, askRecords: {} });
  useAssistantStore.setState({ threads: { nova: { snapshot: snapshot([openCard, chipAsk]), pending: [], signedIn: {} } } });
});

afterEach(() => {
  wire.queue.cancelAll();
  vi.useRealTimers();
});

describe("asks", () => {
  it("card and sheet for the same ask send once", () => {
    const key = cardAskKey("S", "k1");
    expect(openAskKey("nova", openCard)).toBe(key);
    answerAsk(key, { turn: null, commands: [{ kind: "agent.ask.answer", sessionId: "S", askId: "k1", results: [] }] }, { card: { sessionId: "S", askId: "k1" } });
    answerAsk(openAskKey("nova", openCard), { turn: { agent: "nova", clientId: "c1", text: "Yes" }, commands: [{ kind: "assistant.ask.resolve", agent: "nova", id: openCard.id, how: "answered", answer: "Yes" }] }, { open: { agent: "nova", id: openCard.id } });
    expect(kinds()).toEqual(["agent.ask.answer"]);
    expect(record(key)?.state).toBe("answering");
  });

  it("keeps the card until the ack, and a timeout keeps it failed with a retry", async () => {
    const key = cardAskKey("S", "k1");
    const failures: string[] = [];
    answerAsk(key, { turn: null, commands: [{ kind: "agent.ask.answer", sessionId: "S", askId: "k1", results: [] }] }, { card: { sessionId: "S", askId: "k1" } }, (reason) => failures.push(reason));
    expect(record(key)?.state).toBe("answering");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(record(key)).toMatchObject({ state: "failed", failure: "command timed out waiting for an ack" });
    expect(failures).toEqual(["command timed out waiting for an ack"]);
    retryAsk(key);
    expect(record(key)?.state).toBe("answering");
    expect(kinds()).toEqual(["agent.ask.answer", "agent.ask.answer"]);
    const last = wire.sent.at(-1);
    if (last !== undefined) wire.queue.onAck(last.id);
    await settle();
    expect(record(key)?.state).toBe("answered");
  });

  it("answers a chip's ask with its turn and resolve as one unit, reusing the turn's clientId on a retry", async () => {
    const key = openAskKey("nova", chipAsk);
    const reply = (clientId: string) => ({ turn: { agent: "nova", clientId, text: "Yes" }, commands: [{ kind: "assistant.ask.resolve" as const, agent: "nova", id: chipAsk.id, how: "answered" as const, answer: "Yes" }] });
    answerAsk(key, reply("first"), { open: { agent: "nova", id: chipAsk.id } });
    expect(kinds()).toEqual(["assistant.turn", "assistant.ask.resolve"]);
    const resolve = wire.sent[1];
    if (resolve !== undefined) wire.queue.onNack(resolve.id, { code: "internal", message: "no" });
    await settle();
    expect(record(key)?.state).toBe("failed");
    // Answering again after the failure: the same turn, not a second one.
    answerAsk(key, reply("second"), { open: { agent: "nova", id: chipAsk.id } });
    const turns = wire.sent.filter((frame) => frame.cmd.kind === "assistant.turn").map((frame) => (frame.cmd.kind === "assistant.turn" ? frame.cmd.clientId : null));
    expect(turns).toEqual(["first"]);
    expect(kinds().filter((kind) => kind === "assistant.ask.resolve")).toHaveLength(2);
  });

  it("is gone when the host drops the ask while answering", () => {
    const key = openAskKey("nova", chipAsk);
    dismissAsk(key, { turn: null, commands: [{ kind: "assistant.ask.resolve", agent: "nova", id: chipAsk.id, how: "dismissed" }] }, { open: { agent: "nova", id: chipAsk.id } });
    expect(record(key)?.state).toBe("dismissing");
    useAssistantStore.getState().set("nova", { ...snapshot([openCard]), rev: 2 });
    expect(record(key)).toBeUndefined();
  });

  it("keeps a card's answered record until the host resolves the card and drops its open ask", async () => {
    const key = cardAskKey("S", "k1");
    answerAsk(key, { turn: null, commands: [{ kind: "agent.ask.answer", sessionId: "S", askId: "k1", results: [] }] }, { card: { sessionId: "S", askId: "k1" }, open: { agent: "nova", id: openCard.id } });
    const sent = wire.sent[0];
    if (sent !== undefined) wire.queue.onAck(sent.id);
    await settle();
    expect(record(key)?.state).toBe("answered");
    // A welcome empties the cards; that is not the host dropping it.
    useAgentsStore.getState().applyWelcome(1, []);
    expect(record(key)?.state).toBe("answered");
    useAgentsStore.getState().clearAsk("S", "k1");
    expect(record(key)?.state).toBe("answered");
    useAssistantStore.getState().set("nova", { ...snapshot([chipAsk]), rev: 2 });
    expect(record(key)).toBeUndefined();
  });
});
