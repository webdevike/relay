import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AckError, ClientMessage, Command } from "@relay/protocol";
import { CommandError, CommandQueue, SIGNIN_TIMEOUT_MS, TURN_TIMEOUT_MS, type CommandReport } from "./commands";
import { QUEUED_TIMEOUT_MS, UNCONFIRMED_TTL_MS } from "./command.machine";

const insertText: Command = { kind: "text.insert", text: "hi" };

function idsFromSent(sent: ClientMessage[]): string[] {
  return sent.map((message) => (message.t === "cmd" ? message.id : "")).filter((id) => id !== "");
}

describe("CommandQueue", () => {
  it("resolves the returned promise when the matching id is acked", async () => {
    const queue = new CommandQueue();
    const promise = queue.enqueue(insertText);
    const sent: ClientMessage[] = [];
    queue.flush((message) => sent.push(message));
    const [sentMessage] = sent;
    if (sentMessage?.t !== "cmd") throw new Error("expected a cmd frame");

    queue.onAck(sentMessage.id);
    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects with the nack's code and message", async () => {
    const queue = new CommandQueue();
    const promise = queue.enqueue(insertText);
    const sent: ClientMessage[] = [];
    queue.flush((message) => sent.push(message));
    const [sentMessage] = sent;
    if (sentMessage?.t !== "cmd") throw new Error("expected a cmd frame");

    const error: AckError = { code: "accessibility_denied", message: "not trusted" };
    queue.onNack(sentMessage.id, error);

    await expect(promise).rejects.toMatchObject({ code: "accessibility_denied", message: "not trusted" });
  });

  it("ignores an ack or nack for an id it no longer knows about", () => {
    const queue = new CommandQueue();
    expect(() => {
      queue.onAck("no-such-id");
    }).not.toThrow();
    expect(() => {
      queue.onNack("no-such-id", { code: "internal", message: "x" });
    }).not.toThrow();
  });

  it("re-sends every still-pending command in enqueue order on reconnect", () => {
    const queue = new CommandQueue();
    void queue.enqueue({ kind: "text.insert", text: "one" });
    void queue.enqueue({ kind: "text.insert", text: "two" });
    void queue.enqueue({ kind: "text.insert", text: "three" });

    const sent: ClientMessage[] = [];
    queue.onReconnect((message) => sent.push(message));

    const ids = idsFromSent(sent);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3); // all distinct

    const sentAgain: ClientMessage[] = [];
    queue.onReconnect((message) => sentAgain.push(message));
    expect(idsFromSent(sentAgain)).toEqual(ids); // same commands, same order, same ids (server dedups)
  });

  describe("with fake timers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const wire = (): { sent: ClientMessage[]; send: (message: ClientMessage) => void } => {
      const sent: ClientMessage[] = [];
      return { sent, send: (message) => sent.push(message) };
    };

    it("rejects with a timeout error 10s after it went on the wire without an ack", async () => {
      const queue = new CommandQueue();
      const promise = queue.enqueue(insertText, wire().send);
      const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    });

    it("gives a sign-in the browser tool's time: still pending after 10s, a timeout at 70s", async () => {
      const queue = new CommandQueue();
      const promise = queue.enqueue({ kind: "assistant.signin", messageId: "m1", url: "https://github.com/login", username: "isaac", password: "pw" }, wire().send);
      const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(queue.size).toBe(1);
      await vi.advanceTimersByTimeAsync(SIGNIN_TIMEOUT_MS - 10_000);
      await assertion;
    });

    it("gives an assistant turn the host's start-up time: still pending after 10s, a timeout at 45s", async () => {
      const queue = new CommandQueue();
      const promise = queue.enqueue({ kind: "assistant.turn", agent: "nova", text: "Have fable 5.2 go through", clientId: "c1" }, wire().send);
      const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(queue.size).toBe(1);
      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS - 10_000);
      await assertion;
    });

    it("keeps a timed-out command as unconfirmed and reports a late ack as acked", async () => {
      const queue = new CommandQueue();
      const reports: CommandReport[] = [];
      queue.onReport((report) => reports.push(report));
      const { sent, send } = wire();
      const promise = queue.enqueue(insertText, send);
      const [id] = idsFromSent(sent);
      if (id === undefined) throw new Error("expected a cmd frame");

      const assertion = expect(promise).rejects.toBeInstanceOf(CommandError);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(queue.stateOf(id)).toBe("unconfirmed");
      expect(queue.size).toBe(0);
      expect(queue.outstanding).toBe(1);

      queue.onAck(id);
      expect(reports.map((report) => report.outcome)).toEqual(["unconfirmed", "acked"]);
      expect(reports[1]).toMatchObject({ id, outcome: "acked", late: true });
      expect(queue.stateOf(id)).toBeNull();
      expect(queue.outstanding).toBe(0);
    });

    it("reports a late nack, and forgets an unconfirmed command no word ever settles", async () => {
      const queue = new CommandQueue();
      const reports: CommandReport[] = [];
      queue.onReport((report) => reports.push(report));
      const first = wire();
      void queue.enqueue(insertText, first.send).catch(() => undefined);
      const second = wire();
      void queue.enqueue({ kind: "text.insert", text: "two" }, second.send).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10_000);
      const [nacked] = idsFromSent(first.sent);
      if (nacked === undefined) throw new Error("expected a cmd frame");
      queue.onNack(nacked, { code: "internal", message: "late" });
      expect(reports.at(-1)).toMatchObject({ id: nacked, outcome: "nacked", late: true });
      expect(queue.outstanding).toBe(1);
      await vi.advanceTimersByTimeAsync(UNCONFIRMED_TTL_MS);
      expect(queue.outstanding).toBe(0);
    });

    it("runs no ack deadline while queued offline, and fails as unsent once the longer never-sent deadline passes", async () => {
      const queue = new CommandQueue();
      const offline = (): boolean => false;
      const promise = queue.enqueue(insertText, offline);
      let settled = false;
      void promise.catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS * 2);
      expect(settled).toBe(false);
      expect(queue.size).toBe(1);
      const assertion = expect(promise).rejects.toMatchObject({ code: "unsent" });
      await vi.advanceTimersByTimeAsync(QUEUED_TIMEOUT_MS);
      await assertion;
      expect(queue.outstanding).toBe(0);
    });

    it("stops the ack deadline when the socket drops and sends again with the same id on reconnect", async () => {
      const queue = new CommandQueue();
      const { sent, send } = wire();
      const promise = queue.enqueue(insertText, send);
      await vi.advanceTimersByTimeAsync(9_000);
      queue.onDisconnect();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(queue.size).toBe(1);
      queue.onReconnect(send);
      const [first, again] = idsFromSent(sent);
      expect(again).toBe(first);
      if (again === undefined) throw new Error("expected a resend");
      // A fresh deadline for the new attempt.
      await vi.advanceTimersByTimeAsync(9_000);
      queue.onAck(again);
      await expect(promise).resolves.toBeUndefined();
    });

    it("retries an unconfirmed turn with the same id when the same clientId is sent again", async () => {
      const queue = new CommandQueue();
      const turn: Command = { kind: "assistant.turn", agent: "nova", text: "ship it", clientId: "k1" };
      const { sent, send } = wire();
      const first = queue.enqueue(turn, send);
      const timedOut = expect(first).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
      await timedOut;

      const retry = queue.enqueue(turn, send);
      const [id, again] = idsFromSent(sent);
      expect(id).toBe("turn-k1");
      expect(again).toBe(id);
      expect(queue.stateOf("turn-k1")).toBe("inflight");
      queue.onAck("turn-k1");
      await expect(retry).resolves.toBeUndefined();
    });

    it("sends the same turn tapped again while it is still on the wire only once, and both callers hear its ack", async () => {
      const queue = new CommandQueue();
      const turn: Command = { kind: "assistant.turn", agent: "nova", text: "ship it", clientId: "k2" };
      const { sent, send } = wire();
      const a = queue.enqueue(turn, send);
      const b = queue.enqueue(turn, send);
      expect(idsFromSent(sent)).toEqual(["turn-k2"]);
      queue.onAck("turn-k2");
      await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
    });
  });

  it("rejects what is pending and forgets the unconfirmed when the phone switches hosts", async () => {
    const queue = new CommandQueue();
    const promise = queue.enqueue(insertText);
    queue.cancelAll();
    await expect(promise).rejects.toMatchObject({ code: "internal" });
    expect(queue.outstanding).toBe(0);
  });

  it("bounds pending commands at 64 and rejects the newest on overflow", async () => {
    const queue = new CommandQueue();
    const accepted = Array.from({ length: 64 }, () => queue.enqueue(insertText));
    expect(queue.size).toBe(64);

    await expect(queue.enqueue(insertText)).rejects.toMatchObject({ code: "internal" });
    expect(queue.size).toBe(64); // overflow did not evict or add anything

    const sent: ClientMessage[] = [];
    queue.flush((message) => sent.push(message));
    for (const message of sent) {
      if (message.t === "cmd") queue.onAck(message.id);
    }
    await Promise.all(accepted);
  });

  it("puts each command on the wire once when it is enqueued, never resending ones still pending", () => {
    const queue = new CommandQueue();
    const sent: ClientMessage[] = [];
    void queue.enqueue({ kind: "assistant.turn", agent: "nova", text: "with a photo", images: [{ mimeType: "image/png", data: "AAAA" }] }, (message) => sent.push(message));
    void queue.enqueue({ kind: "assistant.ask.resolve", agent: "nova", id: "0000000a", how: "answered", answer: "Yes" }, (message) => sent.push(message));
    expect(sent.map((message) => (message.t === "cmd" ? message.cmd.kind : message.t))).toEqual(["assistant.turn", "assistant.ask.resolve"]);
    // A reconnect is where the backlog goes out again.
    const replayed: ClientMessage[] = [];
    queue.onReconnect((message) => replayed.push(message));
    expect(idsFromSent(replayed)).toEqual(idsFromSent(sent));
  });
});
