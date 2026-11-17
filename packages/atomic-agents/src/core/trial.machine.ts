import { assign, fromPromise, setup } from "xstate";
import { clearWinner, type CountedPick, type Decision } from "./Trial.ts";

/**
 * One taste agent's trial (`Trial.ts`), run by `TrialService.ts`: off, or trialing while Isaac's picks come in, or
 * switching once one model clearly wins (the service writes config.json, then says so in the chat). Pure: the switch
 * itself is the `switchModel` actor the service provides.
 */

export interface SwitchInput {
  readonly agent: string;
  readonly arms: ReadonlyArray<string>;
  readonly decision: Decision;
  /** The trial whose pick decided it: Relay shows the agent's message in that chat. */
  readonly trialId: string;
}

export type TrialMachineEvent =
  /** config.json (or the agent file) turned the trial on, or changed its models: count from `picks` (restored at start, else none). */
  | { type: "trial.on"; arms: ReadonlyArray<string>; picks: ReadonlyArray<CountedPick> }
  | { type: "trial.off" }
  /** Isaac picked on a card of this trial's models: the model that won, or null for "can't tell". */
  | { type: "pick.recorded"; pick: CountedPick; trialId: string }
  /** Isaac took Undo on the last switch: what was counted before no longer decides anything. */
  | { type: "switch.undone" };

export const trialMachine = setup({
  types: {
    input: {} as { agent: string },
    context: {} as {
      agent: string;
      arms: ReadonlyArray<string>;
      picks: ReadonlyArray<CountedPick>;
      decision: Decision | null;
      trialId: string | null;
      error: string | null;
    },
    events: {} as TrialMachineEvent,
  },
  actors: {
    // The service provides the real one: config.json `{model: winner, trial: false}`, then `trial.switched`.
    switchModel: fromPromise<void, SwitchInput>(async () => {
      throw new Error("switchModel not provided");
    }),
  },
  guards: {
    decidesTrial: ({ context, event }) =>
      event.type === "pick.recorded" && clearWinner([...context.picks, event.pick]) !== undefined,
  },
  actions: {
    startCounting: assign(({ event }) =>
      event.type === "trial.on"
        ? { arms: event.arms, picks: event.picks, decision: null, trialId: null, error: null }
        : {},
    ),
    addPick: assign({
      picks: ({ context, event }) =>
        event.type === "pick.recorded" ? [...context.picks, event.pick] : context.picks,
    }),
    decide: assign(({ context, event }) =>
      event.type === "pick.recorded"
        ? { decision: clearWinner(context.picks) ?? null, trialId: event.trialId }
        : {},
    ),
    forgetPicks: assign({ picks: [], decision: null }),
  },
}).createMachine({
  id: "trial",
  initial: "off",
  context: ({ input }) => ({
    agent: input.agent,
    arms: [],
    picks: [],
    decision: null,
    trialId: null,
    error: null,
  }),
  states: {
    off: {
      on: {
        "trial.on": { target: "trialing", actions: "startCounting" },
        "switch.undone": { actions: "forgetPicks" },
      },
    },
    trialing: {
      on: {
        "pick.recorded": [
          { guard: "decidesTrial", target: "switching", actions: ["addPick", "decide"] },
          { actions: "addPick" },
        ],
        // New models (a re-trial) or a config edit: a fresh count.
        "trial.on": { target: "trialing", reenter: true, actions: "startCounting" },
        "trial.off": "off",
        "switch.undone": { actions: "forgetPicks" },
      },
    },
    switching: {
      invoke: {
        src: "switchModel",
        input: ({ context }) => ({
          agent: context.agent,
          arms: context.arms,
          decision: context.decision!,
          trialId: context.trialId!,
        }),
        onDone: { target: "off", actions: "forgetPicks" },
        // Config could not be written: keep trialing; the next pick decides again.
        onError: {
          target: "trialing",
          actions: assign({ error: ({ event }) => String(event.error) }),
        },
      },
    },
  },
});
