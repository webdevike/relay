import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "@relay/protocol";
import { sendCommand } from "@/connection";
import { CommandError, CommandQueue, TURN_TIMEOUT_MS, type CommandReport } from "@/connection/commands";
import { threadOf, useAssistantStore } from "./assistant";
import { dismissTurn, retryTurn, startTurn } from "./turns";

/** The real queue behind a fake socket: what went on the wire, and its acks. */
const wire: { sent: { id: string; cmd: Command }[]; queue: CommandQueue } = { sent: [], queue: new CommandQueue() };

vi.mock("@/connection", () => ({
  sendCommand: (cmd: Command) =>
    wire.queue.enqueue(cmd, (message) => {
      if (message.t === "cmd") wire.sent.push({ id: message.id, cmd: message.cmd });
    }),
  onCommandReport: (listener: (report: CommandReport) => void) => wire.queue.onReport(listener),
}));

const echoes = () => threadOf(useAssistantStore.getState(), "nova").pending;
/** Lets the delivery promises settle (no time passes). */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A turn sent as the composer does: the draft goes now, and comes back only through `onRefused`. */
function send(clientId: string, text: string) {
  const restored: string[] = [];
  const command = { kind: "assistant.turn" as const, agent: "nova", text, clientId };
  startTurn({
    agent: "nova",
    clientId,
    text,
    images: [],
    delivery: sendCommand(command),
    command,
    onRefused: () => {
      restored.push(text);
    },
  });
  return { restored };
}

beforeEach(() => {
  vi.useFakeTimers();
  wire.sent = [];
  useAssistantStore.setState({ threads: {} });
});

afterEach(() => {
  wire.queue.cancelAll();
  vi.useRealTimers();
});

describe("turns", () => {
  it("shows the echo synchronously as sending, then sent on the ack", async () => {
    send("k1", "hello");
    expect(echoes()).toMatchObject([{ id: "k1", text: "hello", state: "sending" }]);
    wire.queue.onAck("turn-k1");
    await settle();
    expect(echoes()).toMatchObject([{ id: "k1", state: "sent" }]);
  });

  it("timeout keeps the echo as unconfirmed and does not restore the draft", async () => {
    const { restored } = send("k2", "ship it");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    expect(echoes()).toMatchObject([{ id: "k2", text: "ship it", state: "unconfirmed" }]);
    expect(restored).toEqual([]);
  });

  it("a late ack after the deadline makes the unconfirmed echo sent", async () => {
    send("k3", "late");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    expect(echoes()[0]?.state).toBe("unconfirmed");
    wire.queue.onAck("turn-k3");
    expect(echoes()[0]?.state).toBe("sent");
  });

  it("try again resends the same turn with the same clientId and command id", async () => {
    send("k4", "again");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    retryTurn("nova", "k4");
    expect(echoes()[0]?.state).toBe("sending");
    expect(wire.sent.map((frame) => frame.id)).toEqual(["turn-k4", "turn-k4"]);
    expect(wire.sent.map((frame) => (frame.cmd.kind === "assistant.turn" ? frame.cmd.clientId : null))).toEqual(["k4", "k4"]);
    wire.queue.onAck("turn-k4");
    await settle();
    expect(echoes()[0]?.state).toBe("sent");
  });

  it("refusal drops the echo and restores the draft", async () => {
    const { restored } = send("k5", "nope");
    wire.queue.onNack("turn-k5", { code: "invalid_command", message: "no" });
    await settle();
    expect(echoes()).toEqual([]);
    expect(restored).toEqual(["nope"]);
  });

  it("dismisses a stuck unconfirmed echo", async () => {
    send("k6", "/compact");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    dismissTurn("nova", "k6");
    expect(echoes()).toEqual([]);
  });

  it("ends the turn once its row lands, so a late ack later is ignored", async () => {
    send("k7", "landed");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    useAssistantStore.getState().dropPending("nova", "k7");
    wire.queue.onAck("turn-k7");
    expect(echoes()).toEqual([]);
  });

  it("refuses a turn that never got out (unsent), restoring the draft", async () => {
    const restored: string[] = [];
    startTurn({
      agent: "nova",
      clientId: "k8",
      text: "offline",
      images: [],
      delivery: Promise.reject(new CommandError("unsent", "never sent")),
      command: null,
      onRefused: () => {
        restored.push("offline");
      },
    });
    await settle();
    expect(echoes()).toEqual([]);
    expect(restored).toEqual(["offline"]);
  });
});
