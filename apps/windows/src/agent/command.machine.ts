// Lifecycle of one agent `run` command (pure: xstate and types only). The runtime (`command.ts`)
// provides `process`, which starts PowerShell in Isaac's session, answers `process.kill` by
// killing its whole tree, and reports `process.exited` with what it printed.
//
//   running -> exited                                   (it finished on its own)
//   running -> timingOut -> timedOut                    (it outlived its timeout)
//   running -> cancelling -> cancelled                  (the agent hung up)
//
// A killed process is given `killGrace` to exit so its partial output can still be returned;
// leaving `live` stops the `process` actor either way, which kills whatever is left.

import { assign, fromCallback, sendTo, setup } from "xstate";

export interface CommandExit {
  /** null when the process was killed before it reported a code. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandInput {
  readonly timeoutMs: number;
  readonly killGraceMs: number;
}

export interface CommandContext extends CommandInput {
  readonly exit: CommandExit | null;
}

export type CommandEvent =
  | { readonly type: "process.exited"; readonly exit: CommandExit }
  | { readonly type: "command.cancel" };

/** What the runtime's `process` actor is sent. */
export interface ProcessCommand {
  readonly type: "process.kill";
}

export const commandMachine = setup({
  types: {
    input: {} as CommandInput,
    context: {} as CommandContext,
    events: {} as CommandEvent,
    output: {} as { readonly exit: CommandExit | null },
  },
  actors: {
    // Placeholder; the runtime provides the real one, tests a stub.
    process: fromCallback<ProcessCommand>(() => () => undefined),
  },
  actions: {
    killTree: sendTo("process", { type: "process.kill" } satisfies ProcessCommand),
    recordExit: assign({ exit: (_, params: { exit: CommandExit }) => params.exit }),
  },
  delays: {
    timeout: ({ context }) => context.timeoutMs,
    killGrace: ({ context }) => context.killGraceMs,
  },
}).createMachine({
  id: "command",
  initial: "live",
  context: ({ input }) => ({ ...input, exit: null }),
  states: {
    live: {
      invoke: { id: "process", src: "process" },
      initial: "running",
      states: {
        running: {
          after: { timeout: "timingOut" },
          on: {
            "process.exited": {
              target: "#command.exited",
              actions: { type: "recordExit", params: ({ event }) => ({ exit: event.exit }) },
            },
            "command.cancel": "cancelling",
          },
        },
        timingOut: {
          entry: "killTree",
          after: { killGrace: "#command.timedOut" },
          on: {
            "process.exited": {
              target: "#command.timedOut",
              actions: { type: "recordExit", params: ({ event }) => ({ exit: event.exit }) },
            },
          },
        },
        cancelling: {
          entry: "killTree",
          after: { killGrace: "#command.cancelled" },
          on: {
            "process.exited": {
              target: "#command.cancelled",
              actions: { type: "recordExit", params: ({ event }) => ({ exit: event.exit }) },
            },
          },
        },
      },
    },
    exited: { type: "final" },
    timedOut: { type: "final" },
    cancelled: { type: "final" },
  },
  output: ({ context }) => ({ exit: context.exit }),
});
