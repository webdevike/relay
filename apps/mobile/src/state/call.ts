/**
 * The voice call on this phone, if any: one at a time, with one assistant. The host drives its
 * state with `call.state` frames (`src/call/frames.ts`); the phone sets `muted` and ends it
 * locally when the socket drops or iOS takes the audio session. A call that ends cleanly is cleared
 * at once (`src/call/controller.ts`); one that ends on an error stays here with it until the call
 * screen closes and `clear`s it.
 */
import { create } from "zustand";
import type { CallState } from "@relay/protocol";

export interface ActiveCall {
  readonly id: string;
  readonly agent: string;
  readonly state: CallState;
  /** What was just heard (thinking) or is being said (speaking), or why a turn failed. */
  readonly text: string | null;
  /** Why the call ended, when it did not end by hanging up. */
  readonly error: string | null;
  readonly muted: boolean;
  /** Microphone loudness 0..1, for the call screen. */
  readonly level: number;
  /** `Date.now()` at the start, for the call timer. */
  readonly startedAt: number;
}

export interface CallStore {
  call: ActiveCall | null;
  begin: (id: string, agent: string) => void;
  /** Applies a host `call.state`, or a local change; ignored for any call but the current one. */
  update: (id: string, change: Partial<Pick<ActiveCall, "state" | "text" | "error" | "muted" | "level">>) => void;
  clear: () => void;
}

export const useCallStore = create<CallStore>((set) => ({
  call: null,
  begin: (id, agent) => {
    set({ call: { id, agent, state: "connecting", text: null, error: null, muted: false, level: 0, startedAt: Date.now() } });
  },
  update: (id, change) => {
    set((store) => (store.call?.id === id ? { call: { ...store.call, ...change } } : store));
  },
  clear: () => {
    set({ call: null });
  },
}));

/** Whether a call is up (not ended): the socket then stays open in the background. */
export function callIsLive(): boolean {
  const call = useCallStore.getState().call;
  return call !== null && call.state !== "ended";
}
