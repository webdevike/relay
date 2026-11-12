/**
 * The driver's handle on the session statechart (`session.machine.ts`): one running actor, with
 * `handle(input, now)` mapping a socket, discovery, app or host input to the effects the driver
 * (index.ts) must perform, in order. It provides the machine's one async step, the challenge proof
 * (`authProof` over the injected `sha256`), and waits for it, so `handle` always returns every
 * effect of its input. Deterministic: the only ambient inputs are `sha256`, `random` and `now`.
 */
import { createActor, fromPromise, waitFor, type ActorRefFrom } from "xstate";
import { authProof, type ServerMessage, type Sha256 } from "@relay/protocol";
import type { DiscoveredService } from "./discovery";
import {
  sessionEventOf,
  sessionMachine,
  type ProofInput,
  type SessionEffect,
  type SessionEvent,
  type SessionState,
} from "./session.machine";

export type { SessionState } from "./session.machine";
export type Effect = SessionEffect;

export type SessionInput =
  | { readonly type: "server"; readonly message: ServerMessage }
  | { readonly type: "socketOpen" }
  | { readonly type: "socketClosed" }
  | { readonly type: "serviceFound"; readonly service: DiscoveredService; readonly pairedSecretHex: string | null }
  | { readonly type: "appActive" }
  | { readonly type: "appBackground" }
  | { readonly type: "startPairing" }
  | { readonly type: "pinEntered"; readonly pin: string }
  | { readonly type: "timer" };

export interface SessionDeps {
  readonly sha256: Sha256;
  readonly deviceId: string;
  readonly getDeviceName: () => string;
  readonly random?: () => number;
}

function eventOf(input: SessionInput, now: number): SessionEvent | null {
  switch (input.type) {
    case "server":
      return sessionEventOf(input.message, now);
    case "socketOpen":
      return { type: "socket.opened" };
    case "socketClosed":
      return { type: "socket.closed" };
    case "serviceFound":
      return { type: "discovery.found", service: input.service, pairedSecretHex: input.pairedSecretHex };
    case "appActive":
      return { type: "app.active" };
    case "appBackground":
      return { type: "app.background" };
    case "startPairing":
      return { type: "pairing.start" };
    case "pinEntered":
      return { type: "pairing.pin", pin: input.pin };
    case "timer":
      return { type: "timer.fired", now };
  }
}

export class SessionMachine {
  private readonly actor: ActorRefFrom<typeof sessionMachine>;

  constructor(deps: SessionDeps) {
    const machine = sessionMachine.provide({
      actors: {
        proof: fromPromise<string, ProofInput>(({ input }) => authProof(input.secretHex, input.nonce, deps.sha256)),
      },
    });
    this.actor = createActor(machine, {
      input: { deviceId: deps.deviceId, getDeviceName: deps.getDeviceName, random: deps.random },
    }).start();
  }

  get currentState(): SessionState {
    const value = this.actor.getSnapshot().value;
    return (typeof value === "string" ? value : Object.keys(value)[0]) as SessionState;
  }

  get rttMs(): number | null {
    return this.actor.getSnapshot().context.lastRttMs;
  }

  /** The effects of `input`, in order. Callers must not overlap calls (index.ts serializes them). */
  async handle(input: SessionInput, now: number): Promise<Effect[]> {
    const event = eventOf(input, now);
    if (event === null) return [];
    const effects: Effect[] = [];
    const subscription = this.actor.on("effect", (emitted) => {
      effects.push(emitted.effect);
    });
    try {
      this.actor.send(event);
      await waitFor(this.actor, (snapshot) => !snapshot.hasTag("proving"));
    } finally {
      subscription.unsubscribe();
    }
    return effects;
  }

  /** Stops the actor: a proof still computing is dropped. */
  stop(): void {
    this.actor.stop();
  }
}
