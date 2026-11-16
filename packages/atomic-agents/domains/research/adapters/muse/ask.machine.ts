import { assign, fromCallback, fromPromise, setup } from "xstate"
import type { MuseReply } from "./screen.ts"

/**
 * One question to Muse, start to finish: attach to the app (running, signed in, parked, not in use),
 * open a fresh side chat, type the question, send it, see it posted, then follow the answer until Muse
 * stops working and the text holds still. Every failure ends in `failed` with a kind the caller reports.
 * Pure: the runtime (`driver.ts`) provides the actors, tests provide stubs.
 */

export type FailureKind = "unavailable" | "signed_out" | "busy" | "ui_changed" | "rate_limited" | "timeout"

export class MuseFailure extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message)
  }
}

/** What the watcher reports each time it reads the window, once the question is out. */
export interface Progress {
  /** The question is in the chat as the user's message. */
  readonly posted: boolean
  /** Muse is still answering (its composer offers Stop). */
  readonly working: boolean
  /** The answer is Muse refusing for load (rate limit, message cap), not answering. */
  readonly rateLimited: boolean
  readonly reply: MuseReply | undefined
}

export type AskOutput =
  | { readonly ok: true; readonly reply: MuseReply }
  | { readonly ok: false; readonly kind: FailureKind; readonly message: string; readonly partial?: MuseReply }

type ProgressEvent = { type: "muse.progress"; progress: Progress }

export const askMachine = setup({
  types: {
    input: {} as { readonly prompt: string },
    context: {} as {
      readonly prompt: string
      readonly reply: MuseReply | undefined
      readonly working: boolean
      readonly failure: { readonly kind: FailureKind; readonly message: string } | undefined
    },
    events: {} as ProgressEvent,
    output: {} as AskOutput
  },
  actors: {
    attach: fromPromise<void>(async () => {
      throw new Error("attach not provided")
    }),
    openChat: fromPromise<void>(async () => {
      throw new Error("openChat not provided")
    }),
    typePrompt: fromPromise<void, { prompt: string }>(async () => {
      throw new Error("typePrompt not provided")
    }),
    send: fromPromise<void>(async () => {
      throw new Error("send not provided")
    }),
    watch: fromCallback<ProgressEvent>(() => {
      throw new Error("watch not provided")
    })
  },
  guards: {
    isPosted: ({ event }) => event.progress.posted,
    isRateLimited: ({ event }) => event.progress.rateLimited,
    // Any change (text, or Muse starting or stopping work) restarts the settle wait; so does every read while working.
    hasMoved: ({ context, event }) =>
      event.progress.working || event.progress.working !== context.working || event.progress.reply?.text !== context.reply?.text,
    isSettled: ({ context }) => !context.working && (context.reply?.text ?? "") !== ""
  },
  delays: {
    postTimeout: 20_000,
    answerTimeout: 360_000,
    settle: 6_000
  },
  actions: {
    recordFailure: assign({
      failure: (_, params: { error: unknown }) =>
        params.error instanceof MuseFailure
          ? { kind: params.error.kind, message: params.error.message }
          : { kind: "ui_changed" as const, message: params.error instanceof Error ? params.error.message : String(params.error) }
    }),
    recordProgress: assign({
      reply: ({ context, event }) => event.progress.reply ?? context.reply,
      working: ({ event }) => event.progress.working
    })
  }
}).createMachine({
  id: "museAsk",
  initial: "attaching",
  context: ({ input }) => ({ prompt: input.prompt, reply: undefined, working: false, failure: undefined }),
  states: {
    attaching: {
      invoke: {
        src: "attach",
        onDone: "opening",
        onError: { target: "failed", actions: { type: "recordFailure", params: ({ event }) => ({ error: event.error }) } }
      }
    },
    opening: {
      invoke: {
        src: "openChat",
        onDone: "typing",
        onError: { target: "failed", actions: { type: "recordFailure", params: ({ event }) => ({ error: event.error }) } }
      }
    },
    typing: {
      invoke: {
        src: "typePrompt",
        input: ({ context }) => ({ prompt: context.prompt }),
        onDone: "sending",
        onError: { target: "failed", actions: { type: "recordFailure", params: ({ event }) => ({ error: event.error }) } }
      }
    },
    sending: {
      invoke: {
        src: "send",
        onDone: "live",
        onError: { target: "failed", actions: { type: "recordFailure", params: ({ event }) => ({ error: event.error }) } }
      }
    },
    live: {
      invoke: { src: "watch" },
      initial: "posting",
      after: {
        answerTimeout: {
          target: "failed",
          actions: assign({ failure: { kind: "timeout", message: "Muse did not finish answering in 6 minutes" } })
        }
      },
      states: {
        posting: {
          on: { "muse.progress": { guard: "isPosted", target: "answering", actions: "recordProgress" } },
          after: {
            postTimeout: {
              target: "#museAsk.failed",
              actions: assign({ failure: { kind: "ui_changed", message: "the question never showed up in the Muse chat (the composer did not take it)" } })
            }
          }
        },
        answering: {
          on: {
            "muse.progress": [
              {
                guard: "isRateLimited",
                target: "#museAsk.failed",
                actions: assign({
                  reply: ({ event }) => event.progress.reply,
                  failure: ({ event }) => ({ kind: "rate_limited" as const, message: `Muse refused: ${event.progress.reply?.text.slice(0, 200) ?? ""}` })
                })
              },
              { guard: "hasMoved", target: "answering", reenter: true, actions: "recordProgress" }
            ]
          },
          after: { settle: { guard: "isSettled", target: "#museAsk.done" } }
        }
      }
    },
    done: { type: "final" },
    failed: { type: "final" }
  },
  // `done` is only reached settled with an answer; every way into `failed` records why.
  output: ({ context }) =>
    context.failure === undefined && context.reply !== undefined
      ? { ok: true, reply: context.reply }
      : { ok: false, ...(context.failure ?? { kind: "ui_changed" as const, message: "Muse stopped without an answer" }), ...(context.reply === undefined ? {} : { partial: context.reply }) }
})
