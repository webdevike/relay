import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "@relay/protocol";
import { CommandQueue, type CommandReport } from "@/connection/commands";
import { buttonEnabled, pressButton, syncOpenUIRuntime } from "@/agents/openui";
import type { ButtonSpec } from "@/agents/widget";
import { threadOf, useAssistantStore } from "@/state/assistant";
import { placeDraft } from "@/state/threadHandoff";
import {
  routeReply,
  sendCaption,
  sendToAssistant,
  type ReplyTargets,
  type SendOutcome,
} from "./assistantSend";

/** The real queue behind a fake socket: what went on the wire, and its acks. */
const wire: { sent: { id: string; cmd: Command }[]; queue: CommandQueue } = {
  sent: [],
  queue: new CommandQueue(),
};

vi.mock("@/connection", () => ({
  sendCommand: (cmd: Command) =>
    wire.queue.enqueue(cmd, (message) => {
      if (message.t === "cmd") wire.sent.push({ id: message.id, cmd: message.cmd });
    }),
  onCommandReport: (listener: (report: CommandReport) => void) => wire.queue.onReport(listener),
}));

/** Lets the sends settle (no time passes). */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A board: no session to reply to; sends to an assistant record their outcome as the tile would caption it. */
function board(): { targets: ReplyTargets; outcomes: Promise<SendOutcome>[] } {
  const outcomes: Promise<SendOutcome>[] = [];
  return {
    outcomes,
    targets: {
      session: null,
      assistant: (agent, text) => {
        const outcome = sendToAssistant(agent, text);
        if (outcome !== null) outcomes.push(outcome);
      },
    },
  };
}

/** A tap on `spec` as ButtonWidget makes it, where `targets` say replies go. */
function tap(spec: ButtonSpec, targets: ReplyTargets): void {
  const { reply, agent } = pressButton(spec, null);
  if (reply !== undefined) routeReply(reply, agent, targets);
}

const toPenny: ButtonSpec = {
  widget: "button",
  label: "Add lamp",
  reply: "Add the lamp to my list",
  agent: "penny",
  variant: "primary",
};
const plainReply: ButtonSpec = { widget: "button", label: "Yes", reply: "yes", variant: "primary" };

beforeEach(() => {
  vi.useFakeTimers();
  wire.sent = [];
  useAssistantStore.setState({ agents: [{ id: "penny", title: "Penny" }], threads: {} });
});

afterEach(() => {
  wire.queue.cancelAll();
  vi.useRealTimers();
});

describe("a board button that names an assistant", () => {
  it("is enabled on a board and sends its reply as an assistant.turn to that assistant", async () => {
    expect(buttonEnabled(toPenny, null, false)).toBe(true);
    const { targets, outcomes } = board();
    tap(toPenny, targets);
    expect(wire.sent.map((frame) => frame.cmd)).toEqual([
      {
        kind: "assistant.turn",
        agent: "penny",
        text: "Add the lamp to my list",
        clientId: expect.any(String) as string,
      },
    ]);
    // The thread shows it as Isaac's turn, like one he typed.
    expect(
      threadOf(useAssistantStore.getState(), "penny").pending.map((echo) => echo.text),
    ).toEqual(["Add the lamp to my list"]);
    const frame = wire.sent[0];
    if (frame !== undefined) wire.queue.onAck(frame.id);
    await settle();
    const outcome = await outcomes[0];
    expect(outcome).toEqual({ kind: "sent" });
    if (outcome !== undefined) expect(sendCaption(outcome, "Penny")).toBe("Sent to Penny");
  });

  it("captions the host's reason when it refuses", async () => {
    const { targets, outcomes } = board();
    tap({ ...toPenny, agent: "ghost" }, targets);
    const frame = wire.sent[0];
    if (frame !== undefined)
      wire.queue.onNack(frame.id, {
        code: "agent_not_found",
        message: "no assistant ghost on this host",
      });
    await settle();
    const outcome = await outcomes[0];
    expect(outcome).toEqual({ kind: "refused", message: "no assistant ghost on this host" });
    if (outcome !== undefined)
      expect(sendCaption(outcome, "ghost")).toBe("Not sent: no assistant ghost on this host");
  });

  it("sends once for a double tap while the first is on its way", () => {
    const { targets } = board();
    tap(toPenny, targets);
    tap(toPenny, targets);
    expect(wire.sent).toHaveLength(1);
  });

  it("keeps a plain reply disabled on a board and sends nothing for it", () => {
    expect(buttonEnabled(plainReply, null, false)).toBe(false);
    tap(plainReply, board().targets);
    expect(wire.sent).toEqual([]);
    // In a session it still answers that session, as before.
    expect(buttonEnabled(plainReply, null, true)).toBe(true);
    const session: string[] = [];
    tap(plainReply, { session: (text) => session.push(text), assistant: () => undefined });
    expect(session).toEqual(["yes"]);
  });

  it("sends an openui @ToAssistant(text, agent) button from a board", () => {
    const runtime = syncOpenUIRuntime(
      null,
      'root = Button("Add lamp", @ToAssistant("Add the lamp", "penny"))',
      false,
    );
    const node = runtime.snapshot().node;
    if (node?.widget !== "button") throw new Error("no button");
    expect(buttonEnabled(node, runtime, false)).toBe(true);
    const { reply, agent } = pressButton(node, runtime);
    routeReply(reply ?? "", agent, board().targets);
    expect(wire.sent.map((frame) => frame.cmd)).toMatchObject([
      { kind: "assistant.turn", agent: "penny", text: "Add the lamp" },
    ]);
  });
});

describe("a Mantine tile's relay.reply on a board", () => {
  it("goes to the assistant it names and does nothing without one", () => {
    const { targets } = board();
    routeReply("Add the lamp", "penny", targets);
    routeReply("yes", undefined, targets);
    expect(wire.sent.map((frame) => frame.cmd)).toMatchObject([
      { kind: "assistant.turn", agent: "penny", text: "Add the lamp" },
    ]);
  });
});

describe("placeDraft", () => {
  it("puts a handed draft in an empty composer, after typed text otherwise, once", () => {
    expect(placeDraft("", "Add the lamp")).toBe("Add the lamp");
    expect(placeDraft("Also", "Add the lamp")).toBe("Also\n\nAdd the lamp");
    expect(placeDraft("Also\n\nAdd the lamp", "Add the lamp")).toBe("Also\n\nAdd the lamp");
  });
});
