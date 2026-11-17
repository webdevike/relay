/**
 * Trial mode (protocol "trials"): the comparison cards and switch messages of Relay's taste agents,
 * as the host's latest `trials.snapshot` (every chat at once; a thread's screen filters by thread).
 * Not persisted: the host owns them. The driver asks with `trials.get` on every welcome of a host
 * whose features offer TRIALS_FEATURE, and the host pushes a new snapshot to every device on each
 * change (a result in, a pick, a switch, an undo).
 *
 * A card or switch message that first appears in a pushed snapshot is `fresh` until its row draws
 * it once (it keeps the list's place, as a reply widget does); the answer to `trials.get` is drawn
 * still. `picking` and `undoing` hold what this phone sent and the host has not answered yet;
 * `failure` is the last answer the host refused (or a send that could not go out), for a toast.
 */
import { create } from "zustand";
import { TRIALS_FEATURE, type TrialPick, type TrialsSnapshot } from "@relay/protocol";

export interface TrialFailure {
  /** The chat of the card or switch it was about; undefined when the snapshot no longer has it. */
  thread: string | undefined;
  text: string;
}

export interface TrialsStore {
  /** The host keeps trials (`welcome.features`); false while not connected. */
  up: boolean;
  snapshot: TrialsSnapshot;
  /** Card and switch ids that arrived live and have not been drawn yet. */
  fresh: readonly string[];
  /** A `trials.get` is out: the next snapshot is its answer, drawn without motion. */
  asked: boolean;
  /** Picks sent from this phone the host has not answered, by trial id. */
  picking: Readonly<Record<string, TrialPick>>;
  /** Undos sent from this phone the host has not answered, by switch id. */
  undoing: Readonly<Record<string, true>>;
  /** The last pick or undo that did not go through; a new object every time. */
  failure: TrialFailure | null;
  /** A welcome: what this host offers. */
  setFeatures: (features: readonly string[] | undefined) => void;
  /** The socket went: nothing can be sent until the next welcome; what was shown stays. */
  clearFeatures: () => void;
  /** `trials.get` went out. */
  ask: () => void;
  /** The host's snapshot, replacing the last one. */
  apply: (snapshot: TrialsSnapshot) => void;
  /** Card or switch `id` drew its fresh arrival: it never animates again. */
  settle: (id: string) => void;
  /** `trial.pick` went out. */
  sentPick: (trial: string, pick: TrialPick) => void;
  /** `trial.undo` went out. */
  sentUndo: (switchId: string) => void;
  /** The host's `trial.picked`. */
  picked: (trial: string, ok: boolean, error: string | undefined) => void;
  /** The host's `trial.undone`. */
  undone: (switchId: string, ok: boolean, error: string | undefined) => void;
  /** A pick or undo could not be sent at all. */
  fail: (failure: TrialFailure) => void;
  /** Forget everything (another host). */
  clear: () => void;
}

const EMPTY: TrialsSnapshot = { trials: [], switches: [] };

function idsOf(snapshot: TrialsSnapshot): Set<string> {
  return new Set([
    ...snapshot.trials.map((trial) => trial.id),
    ...snapshot.switches.map((entry) => entry.id),
  ]);
}

/** The ids of `next` that `previous` did not have. */
export function arrivedIds(previous: TrialsSnapshot, next: TrialsSnapshot): string[] {
  const known = idsOf(previous);
  return [...idsOf(next)].filter((id) => !known.has(id));
}

/** What the toast says when the host refused a pick or an undo. */
export function refusalText(kind: "pick" | "undo", error: string | undefined): string {
  const head = kind === "pick" ? "Pick not saved" : "Undo didn't go through";
  return error === undefined || error.trim() === "" ? head : `${head}: ${error.trim()}`;
}

export const useTrialsStore = create<TrialsStore>((set) => ({
  up: false,
  snapshot: EMPTY,
  fresh: [],
  asked: false,
  picking: {},
  undoing: {},
  failure: null,
  setFeatures: (features) => {
    set({ up: features?.includes(TRIALS_FEATURE) === true });
  },
  clearFeatures: () => {
    // Whatever was in flight is answered on the socket that carried it or not at all.
    set({ up: false, asked: false, picking: {}, undoing: {} });
  },
  ask: () => {
    set({ asked: true });
  },
  apply: (snapshot) => {
    set((state) => {
      const ids = idsOf(snapshot);
      const added = state.asked ? [] : arrivedIds(state.snapshot, snapshot);
      const fresh = [...state.fresh.filter((id) => ids.has(id) && !added.includes(id)), ...added];
      // A pick the snapshot already shows (or a card that is gone) is no longer in flight.
      const picking = Object.fromEntries(
        Object.entries(state.picking).filter(
          ([id]) =>
            snapshot.trials.find((trial) => trial.id === id)?.pick === undefined && ids.has(id),
        ),
      );
      const undoing = Object.fromEntries(
        Object.entries(state.undoing).filter(
          ([id]) => snapshot.switches.find((entry) => entry.id === id)?.undone === false,
        ),
      );
      return { snapshot, fresh, asked: false, picking, undoing };
    });
  },
  settle: (id) => {
    set((state) =>
      state.fresh.includes(id) ? { fresh: state.fresh.filter((other) => other !== id) } : {},
    );
  },
  sentPick: (trial, pick) => {
    set((state) => ({ picking: { ...state.picking, [trial]: pick } }));
  },
  sentUndo: (switchId) => {
    set((state) => ({ undoing: { ...state.undoing, [switchId]: true } }));
  },
  picked: (trial, ok, error) => {
    set((state) => {
      const picking = Object.fromEntries(
        Object.entries(state.picking).filter(([id]) => id !== trial),
      );
      const thread = state.snapshot.trials.find((entry) => entry.id === trial)?.thread;
      return { picking, ...(ok ? {} : { failure: { thread, text: refusalText("pick", error) } }) };
    });
  },
  undone: (switchId, ok, error) => {
    set((state) => {
      const undoing = Object.fromEntries(
        Object.entries(state.undoing).filter(([id]) => id !== switchId),
      );
      const thread = state.snapshot.switches.find((entry) => entry.id === switchId)?.thread;
      return { undoing, ...(ok ? {} : { failure: { thread, text: refusalText("undo", error) } }) };
    });
  },
  fail: (failure) => {
    set({ failure: { ...failure } });
  },
  clear: () => {
    set({ snapshot: EMPTY, fresh: [], asked: false, picking: {}, undoing: {}, failure: null });
  },
}));
