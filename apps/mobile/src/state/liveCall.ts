/**
 * The live (GPT-Live) call on this phone, mirrored from the native engine (modules/live-call):
 * it runs natively, also with no JS (the Action Button), so this store only follows its `state`
 * events and `current()`. A call that ends cleanly, or hands over to the legacy call (`fallback`),
 * is cleared at once; one that ends on an error stays until its screen is closed. `failure` is a
 * legacy call that a fallback could not start, shown on that assistant's thread.
 */
import { create } from "zustand";
import type { LiveCallSnapshot } from "../../modules/live-call";

export interface LiveCallFailure {
  readonly agent: string;
  readonly message: string;
}

export interface LiveCallStore {
  call: LiveCallSnapshot | null;
  failure: LiveCallFailure | null;
  apply: (snapshot: LiveCallSnapshot | null) => void;
  dismiss: () => void;
  setFailure: (failure: LiveCallFailure | null) => void;
}

/** What the store holds after the engine reports `snapshot` (null: no call running). */
export function nextLiveCall(previous: LiveCallSnapshot | null, snapshot: LiveCallSnapshot | null): LiveCallSnapshot | null {
  if (snapshot === null) return previous?.state === "ended" ? previous : null;
  if (snapshot.state !== "ended") return snapshot;
  // A late `ended` from a call already replaced by a newer one.
  if (previous !== null && previous.callId !== snapshot.callId && previous.state !== "ended") return previous;
  return snapshot.fallback || snapshot.error === undefined ? null : snapshot;
}

export const useLiveCallStore = create<LiveCallStore>((set) => ({
  call: null,
  failure: null,
  apply: (snapshot) => {
    set((store) => ({ call: nextLiveCall(store.call, snapshot) }));
  },
  dismiss: () => {
    set({ call: null });
  },
  setFailure: (failure) => {
    set({ failure });
  },
}));

/** Whether a live call is up (not ended). */
export function liveCallIsUp(): boolean {
  const call = useLiveCallStore.getState().call;
  return call !== null && call.state !== "ended";
}
