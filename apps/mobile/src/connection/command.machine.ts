/**
 * One reliable command's lifecycle (XState v5), phone -> host. A command is `queued` until it is on
 * the wire of a live socket, `inflight` while the host owes it an ack, and `unconfirmed` once the
 * ack deadline passed while it was on the wire: the host may still be running it (a turn waits for
 * its assistant's omp to start), so the outcome is unknown, never a failure. A late ack there
 * still settles it as acked and is reported, so the caller can show the turn delivered.
 *
 * The ack deadline runs only while inflight: a command waiting for a socket has spent none of it.
 * A queued command has its own, longer deadline instead; reaching that is a true failure (`unsent`),
 * since nothing ever left the phone. A socket that drops puts its inflight commands back in
 * `queued`; the next welcome sends them again with the same id (the host dedups by id), as does a
 * retry of an unconfirmed one.
 *
 * Pure: no timers of its own (the actor's clock runs the delays), no socket. The runtime
 * (`commands.ts` `CommandQueue`) sends the frame, then reports `command.sent`, and listens to the emitted
 * outcomes to settle the caller's promise.
 */
import { assign, emit, setup, type SnapshotFrom } from "xstate";
import type { AckError } from "@relay/protocol";

/** How long a command waits for a socket before it counts as never sent. */
export const QUEUED_TIMEOUT_MS = 120_000;
/** How long an unconfirmed command is kept for a late ack before it is forgotten. */
export const UNCONFIRMED_TTL_MS = 10 * 60_000;

export interface CommandInput {
  /** Ack deadline once on the wire. */
  ackMs: number;
  /** Never-sent deadline while queued; defaults to `QUEUED_TIMEOUT_MS`. */
  queuedMs?: number;
}

export interface CommandContext {
  ackMs: number;
  queuedMs: number;
  /** The nack that settled it, if one did. */
  error: AckError | null;
}

export type CommandEvent =
  /** The frame went out on a live socket. */
  | { type: "command.sent" }
  /** The socket it went out on is gone: it is no longer on the wire this epoch. */
  | { type: "socket.closed" }
  | { type: "command.acked" }
  | { type: "command.nacked"; error: AckError }
  /** Send an unconfirmed command again, with the same id. */
  | { type: "command.retry" }
  /** The phone switched hosts: a replay would land on the wrong computer. */
  | { type: "command.cancel" };

/** What the runtime hears: `late` outcomes arrive after the caller was told `unconfirmed`. */
export type CommandEmitted =
  | { type: "outcome.acked"; late: boolean }
  | { type: "outcome.nacked"; error: AckError; late: boolean }
  | { type: "outcome.unconfirmed" }
  | { type: "outcome.unsent" }
  | { type: "outcome.cancelled" };

export const commandMachine = setup({
  types: {
    context: {} as CommandContext,
    events: {} as CommandEvent,
    input: {} as CommandInput,
    emitted: {} as CommandEmitted,
  },
  actions: {
    keepError: assign({ error: ({ event }) => (event.type === "command.nacked" ? event.error : null) }),
    reportAcked: emit({ type: "outcome.acked", late: false }),
    reportLateAck: emit({ type: "outcome.acked", late: true }),
    reportNacked: emit(({ context }) => ({ type: "outcome.nacked" as const, error: context.error ?? { code: "internal", message: "refused" }, late: false })),
    reportLateNack: emit(({ context }) => ({ type: "outcome.nacked" as const, error: context.error ?? { code: "internal", message: "refused" }, late: true })),
    reportUnconfirmed: emit({ type: "outcome.unconfirmed" }),
    reportUnsent: emit({ type: "outcome.unsent" }),
    reportCancelled: emit({ type: "outcome.cancelled" }),
  },
  delays: {
    ACK_DEADLINE: ({ context }) => context.ackMs,
    QUEUED_DEADLINE: ({ context }) => context.queuedMs,
    UNCONFIRMED_TTL: UNCONFIRMED_TTL_MS,
  },
}).createMachine({
  id: "command",
  context: ({ input }) => ({ ackMs: input.ackMs, queuedMs: input.queuedMs ?? QUEUED_TIMEOUT_MS, error: null }),
  initial: "queued",
  states: {
    queued: {
      after: { QUEUED_DEADLINE: { target: "unsent" } },
      on: {
        "command.sent": { target: "inflight" },
        // A command whose socket dropped before its ack may still be answered after the welcome replays it.
        "command.acked": { target: "acked", actions: "reportAcked" },
        "command.nacked": { target: "nacked", actions: ["keepError", "reportNacked"] },
        "command.cancel": { target: "cancelled" },
      },
    },
    inflight: {
      after: { ACK_DEADLINE: { target: "unconfirmed" } },
      on: {
        // Sent again on a new socket: a fresh deadline for the new attempt.
        "command.sent": { target: "inflight", reenter: true },
        "socket.closed": { target: "queued" },
        "command.acked": { target: "acked", actions: "reportAcked" },
        "command.nacked": { target: "nacked", actions: ["keepError", "reportNacked"] },
        "command.cancel": { target: "cancelled" },
      },
    },
    unconfirmed: {
      entry: "reportUnconfirmed",
      after: { UNCONFIRMED_TTL: { target: "expired" } },
      on: {
        "command.acked": { target: "acked", actions: "reportLateAck" },
        "command.nacked": { target: "nacked", actions: ["keepError", "reportLateNack"] },
        "command.retry": { target: "queued" },
        // Nobody waits on it any more: dropped without a word.
        "command.cancel": { target: "expired" },
      },
    },
    acked: { type: "final" },
    nacked: { type: "final" },
    unsent: { type: "final", entry: "reportUnsent" },
    cancelled: { type: "final", entry: "reportCancelled" },
    /** Unconfirmed for `UNCONFIRMED_TTL_MS` with no word from the host, or cancelled then: forgotten. */
    expired: { type: "final" },
  },
});

export type CommandSnapshot = SnapshotFrom<typeof commandMachine>;
export type CommandState = CommandSnapshot["value"];
