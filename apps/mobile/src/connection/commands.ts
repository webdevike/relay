/**
 * Reliable command queue for `Command`s sent phone -> Mac. Each enqueued command is tracked until
 * it is acked, nacked, or times out; `flush`/`onReconnect` resend everything still pending (the
 * Mac dedups by id, so a redundant resend is harmless). No socket access here: the driver
 * supplies `send` and forwards `ack`/`nack` frames in.
 */
import type { AckError, ClientMessage, Command } from "@relay/protocol";

const MAX_PENDING = 64;
const TIMEOUT_MS = 10_000;

/** Rejection shape for a nacked or timed-out command: `AckError`'s fields plus `"timeout"`. */
export class CommandError extends Error {
  readonly code: AckError["code"] | "timeout";

  constructor(code: AckError["code"] | "timeout", message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

interface PendingCommand {
  readonly id: string;
  readonly cmd: Command;
  readonly resolve: () => void;
  readonly reject: (error: CommandError) => void;
  readonly timer: number;
}

export class CommandQueue {
  private readonly pending = new Map<string, PendingCommand>();
  private counter = 0;
  private readonly nextId: () => string;

  constructor(nextId: () => string = () => Math.random().toString(36).slice(2)) {
    this.nextId = nextId;
  }

  get size(): number {
    return this.pending.size;
  }

  enqueue(cmd: Command): Promise<void> {
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(new CommandError("internal", "too many commands pending"));
    }
    return new Promise<void>((resolve, reject) => {
      const id = `c-${++this.counter}-${this.nextId()}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CommandError("timeout", "command timed out waiting for an ack"));
      }, TIMEOUT_MS);
      this.pending.set(id, { id, cmd, resolve, reject, timer });
    });
  }

  onAck(id: string): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve();
  }

  onNack(id: string, error: AckError): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.reject(new CommandError(error.code, error.message));
  }

  /** Sends every still-pending command, oldest first. */
  flush(send: (message: ClientMessage) => void): void {
    for (const entry of this.pending.values()) {
      send({ t: "cmd", id: entry.id, cmd: entry.cmd });
    }
  }

  /** Call once the socket reconnects: resends the backlog (the Mac dedups by id). */
  onReconnect(send: (message: ClientMessage) => void): void {
    this.flush(send);
  }
}
