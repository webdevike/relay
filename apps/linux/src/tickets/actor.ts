// The tickets sync machine's runtime (sync.machine.ts): its steps are the service's (identity,
// Linear, GitHub, reconcile, wipe), each handed the actor's abort signal so stopping the host or an
// identity change cancels a cycle between calls. A step's failure reaches the machine in the host's
// words (its `lastError` goes to clients); a RateLimited stays as it is, its wait drives the backoff.

import { createActor, fromPromise, type Actor } from "xstate";
import { RateLimited } from "./budget";
import { HostError, publicError } from "./errors";
import { ticketsSyncMachine, TICKETS_SYNC_TIMING, type IdentifyOutput, type LinearStepOutput, type TicketsSyncTiming } from "./sync.machine";

const worded = <T>(step: Promise<T>): Promise<T> =>
  step.catch((error: unknown) => {
    throw error instanceof RateLimited ? error : new HostError(publicError(error));
  });

export interface TicketsSyncSteps {
  identify(signal: AbortSignal): Promise<IdentifyOutput>;
  linear(signal: AbortSignal): Promise<LinearStepOutput>;
  github(signal: AbortSignal): Promise<void>;
  reconcile(signal: AbortSignal): Promise<void>;
  wipe(): Promise<void>;
}

export type TicketsSyncActor = Actor<typeof ticketsSyncMachine>;

/** xstate's clock seam (SimulatedClock in tests). */
type Clock = NonNullable<Parameters<typeof createActor>[1]>["clock"];

export interface TicketsSyncOptions {
  readonly steps: TicketsSyncSteps;
  readonly timing?: Partial<TicketsSyncTiming>;
  readonly clock?: Clock;
}

/** A sync actor, not yet started. */
export function ticketsSyncActor(o: TicketsSyncOptions): TicketsSyncActor {
  const { steps } = o;
  const machine = ticketsSyncMachine.provide({
    actors: {
      identify: fromPromise<IdentifyOutput>(({ signal }) => worded(steps.identify(signal))),
      linear: fromPromise<LinearStepOutput>(({ signal }) => worded(steps.linear(signal))),
      github: fromPromise<null>(async ({ signal }) => {
        await worded(steps.github(signal));
        return null;
      }),
      reconcile: fromPromise<null>(async ({ signal }) => {
        await worded(steps.reconcile(signal));
        return null;
      }),
      wipe: fromPromise<null>(async () => {
        await worded(steps.wipe());
        return null;
      }),
    },
  });
  const timing: TicketsSyncTiming = { ...TICKETS_SYNC_TIMING, random: Math.random, ...o.timing };
  return createActor(machine, { input: { timing }, ...(o.clock === undefined ? {} : { clock: o.clock }) });
}
