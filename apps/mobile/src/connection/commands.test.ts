import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AckError, ClientMessage, Command } from "@relay/protocol";
import { CommandError, CommandQueue, SIGNIN_TIMEOUT_MS, TURN_TIMEOUT_MS } from "./commands";

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

    it("rejects with a timeout error after 10s without an ack", async () => {
      const queue = new CommandQueue();
      const promise = queue.enqueue(insertText);
      const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    });

    it("gives a sign-in the browser tool's time: still pending after 10s, a timeout at 70s", async () => {
      const queue = new CommandQueue();
      const promise = queue.enqueue({ kind: "assistant.signin", messageId: "m1", url: "https://github.com/login", username: "isaac", password: "pw" });
      const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(queue.size).toBe(1);
      await vi.advanceTimersByTimeAsync(SIGNIN_TIMEOUT_MS - 10_000);
      await assertion;
    });

    it("gives an assistant turn the host's start-up time: still pending after 10s, a timeout at 45s", async () => {
      const queue = new CommandQueue();
      const promise = queue.enqueue({ kind: "assistant.turn", agent: "nova", text: "Have fable 5.2 go through", clientId: "c1" });
      const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(queue.size).toBe(1);
      await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS - 10_000);
      await assertion;
    });

    it("drops a command once it has timed out, so a late ack is a no-op", async () => {
      const queue = new CommandQueue();
      const promise = queue.enqueue(insertText);
      const sent: ClientMessage[] = [];
      queue.flush((message) => sent.push(message));
      const [sentMessage] = sent;
      if (sentMessage?.t !== "cmd") throw new Error("expected a cmd frame");

      const assertion = expect(promise).rejects.toBeInstanceOf(CommandError);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(() => {
        queue.onAck(sentMessage.id);
      }).not.toThrow();
      expect(queue.size).toBe(0);
    });
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
