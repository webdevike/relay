/**
 * Reliable command queue for `Command`s sent phone -> Mac: one `commandMachine` actor per command
 * id (queued, inflight, unconfirmed, then acked, nacked, unsent or cancelled). No socket access
 * here: the driver supplies `send` (false when the socket is not open) and forwards `ack`/`nack`
 * frames and socket drops in. `flush`/`onReconnect` send everything not yet acked again (the Mac
 * dedups by id, so a redundant resend is harmless).
 *
 * A caller's promise resolves on the ack and rejects on a nack, on a command that never got out
 * (`unsent`), or with code `"timeout"` once it is unconfirmed. An unconfirmed command lives on: a
 * late ack or nack is reported to `onReport` listeners, and enqueueing the same id again (an
 * `assistant.turn` with the same `clientId`) sends it again with that id instead of a new one.
 */
import { createActor, type Actor } from "xstate";
import type { AckError, ClientMessage, Command } from "@relay/protocol";
import { commandMachine } from "./command.machine";

const MAX_PENDING = 64;
const TIMEOUT_MS = 10_000;
/** The host acks a sign-in once the browser tool has typed the credentials and the page settled (it gives the tool 60 s). */
export const SIGNIN_TIMEOUT_MS = 70_000;
/** The host acks a turn once the assistant has it, starting or resuming its omp first (up to 30 s); the desktop gives it 45 s too. */
export const TURN_TIMEOUT_MS = 45_000;

/** Rejection shape for a refused, timed-out or never-sent command: `AckError`'s fields plus `"timeout"` and `"unsent"`. */
export class CommandError extends Error {
  readonly code: AckError["code"] | "timeout" | "unsent";

  constructor(code: AckError["code"] | "timeout" | "unsent", message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

/** What happened to a command after its caller's promise settled, or the moment it became unconfirmed. */
export type CommandReport =
  | { id: string; cmd: Command; outcome: "unconfirmed" }
  | { id: string; cmd: Command; outcome: "acked"; late: boolean }
  | { id: string; cmd: Command; outcome: "nacked"; late: boolean; error: AckError };

/** The command id of `cmd`: a turn's is named by its `clientId`, so sending the same turn again reuses it. */
export function commandIdOf(cmd: Command): string | null {
  return cmd.kind === "assistant.turn" && cmd.clientId !== undefined ? `turn-${cmd.clientId}` : null;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: CommandError) => void;
}

interface Entry {
  readonly id: string;
  readonly cmd: Command;
  readonly actor: Actor<typeof commandMachine>;
  /** Callers waiting on the current attempt; emptied once told. */
  waiters: Waiter[];
}

/** `setTimeout`/`clearTimeout` for the actors' delays; tests pass a `SimulatedClock`. */
type Clock = NonNullable<Parameters<typeof createActor>[1]>["clock"];

export class CommandQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(report: CommandReport) => void>();
  private counter = 0;
  private readonly nextId: () => string;
  private readonly clock: Clock;

  constructor(nextId: () => string = () => Math.random().toString(36).slice(2), options: { clock?: Clock } = {}) {
    this.nextId = nextId;
    this.clock = options.clock;
  }

  /** Commands still waiting for an outcome: queued or on the wire. */
  get size(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (!entry.actor.getSnapshot().matches("unconfirmed")) count += 1;
    return count;
  }

  /** Commands sent or queued whose outcome is not settled: `size` plus the unconfirmed ones. */
  get outstanding(): number {
    return this.entries.size;
  }

  /** The state of command `id`, or null once it settled (or was never known). */
  stateOf(id: string): "queued" | "inflight" | "unconfirmed" | null {
    const value = this.entries.get(id)?.actor.getSnapshot().value;
    return value === "queued" || value === "inflight" || value === "unconfirmed" ? value : null;
  }

  /** Hears every late outcome and every command that turns unconfirmed. Returns the unsubscribe. */
  onReport(listener: (report: CommandReport) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Tracks `cmd` until its ack, nack or deadline, and hands it to `send` once now (a `false` from
   * `send` means no socket: it stays queued for the next welcome). Commands already pending are not
   * sent again here: only `onReconnect` resends them, so one tap never puts a still-unacked turn
   * (and its images) back on the wire. The same turn again (`commandIdOf`) while it is pending
   * waits on that send; while it is unconfirmed it is a retry with the same id.
   */
  enqueue(cmd: Command, send?: (message: ClientMessage) => unknown): Promise<void> {
    const known = commandIdOf(cmd);
    const existing = known === null ? undefined : this.entries.get(known);
    if (existing !== undefined) {
      const promise = this.wait(existing);
      if (existing.actor.getSnapshot().matches("unconfirmed")) {
        existing.actor.send({ type: "command.retry" });
        if (send !== undefined) this.put(existing, send);
      }
      return promise;
    }
    if (this.size >= MAX_PENDING) {
      return Promise.reject(new CommandError("internal", "too many commands pending"));
    }
    const id = known ?? `c-${++this.counter}-${this.nextId()}`;
    const ackMs = cmd.kind === "assistant.signin" ? SIGNIN_TIMEOUT_MS : cmd.kind === "assistant.turn" ? TURN_TIMEOUT_MS : TIMEOUT_MS;
    const actor = createActor(commandMachine, { input: { ackMs }, ...(this.clock === undefined ? {} : { clock: this.clock }) });
    const entry: Entry = { id, cmd, actor, waiters: [] };
    this.entries.set(id, entry);
    this.listen(entry);
    actor.start();
    const promise = this.wait(entry);
    if (send !== undefined) this.put(entry, send);
    return promise;
  }

  onAck(id: string): void {
    this.entries.get(id)?.actor.send({ type: "command.acked" });
  }

  onNack(id: string, error: AckError): void {
    this.entries.get(id)?.actor.send({ type: "command.nacked", error });
  }

  /** The socket closed: what was on its wire waits for the next one, with no ack deadline running. */
  onDisconnect(): void {
    for (const entry of [...this.entries.values()]) entry.actor.send({ type: "socket.closed" });
  }

  /** Rejects everything pending and forgets the unconfirmed: used when the phone switches hosts, where a replay would land on the wrong computer. */
  cancelAll(): void {
    for (const entry of [...this.entries.values()]) entry.actor.send({ type: "command.cancel" });
  }

  /** Sends every command still waiting for an outcome, oldest first; unconfirmed ones go again only on a retry. */
  flush(send: (message: ClientMessage) => unknown): void {
    for (const entry of [...this.entries.values()]) {
      if (!entry.actor.getSnapshot().matches("unconfirmed")) this.put(entry, send);
    }
  }

  /** Call once the socket reconnects: resends the backlog (the Mac dedups by id). */
  onReconnect(send: (message: ClientMessage) => unknown): void {
    this.flush(send);
  }

  private wait(entry: Entry): Promise<void> {
    // Executor form: Hermes on the phone predates Promise.withResolvers.
    return new Promise<void>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  }

  private put(entry: Entry, send: (message: ClientMessage) => unknown): void {
    if (send({ t: "cmd", id: entry.id, cmd: entry.cmd }) !== false) entry.actor.send({ type: "command.sent" });
  }

  private settle(entry: Entry, outcome: { error: CommandError } | null): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const waiter of waiters) {
      if (outcome === null) waiter.resolve();
      else waiter.reject(outcome.error);
    }
  }

  private report(report: CommandReport): void {
    for (const listener of [...this.listeners]) listener(report);
  }

  private listen(entry: Entry): void {
    const { id, cmd, actor } = entry;
    actor.on("outcome.acked", ({ late }) => {
      this.settle(entry, null);
      if (late) this.report({ id, cmd, outcome: "acked", late });
    });
    actor.on("outcome.nacked", ({ error, late }) => {
      this.settle(entry, { error: new CommandError(error.code, error.message) });
      if (late) this.report({ id, cmd, outcome: "nacked", late, error });
    });
    actor.on("outcome.unconfirmed", () => {
      this.settle(entry, { error: new CommandError("timeout", "command timed out waiting for an ack") });
      this.report({ id, cmd, outcome: "unconfirmed" });
    });
    actor.on("outcome.unsent", () => {
      this.settle(entry, { error: new CommandError("unsent", "never sent: no connection to the host") });
    });
    actor.on("outcome.cancelled", () => {
      this.settle(entry, { error: new CommandError("internal", "cancelled: switched hosts") });
    });
    const forget = (): void => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
    };
    actor.subscribe({ complete: forget, error: forget });
  }
}
