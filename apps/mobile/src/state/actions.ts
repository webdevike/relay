/**
 * Screens call `actions.*` directly. Wave 2 (connection/agents/dictation) replaces the
 * implementations at runtime via `setActions` once the real transport exists; until then every
 * action is a no-op so every screen renders and is interactive without a live connection.
 */
export interface RelayActions {
  insertText: (text: string) => Promise<void>;
  startPairing: () => void;
  submitPin: (pin: string) => void;
  /** Connects to host `id`: a saved one with its secret, otherwise starts pairing with it. */
  switchHost: (id: string) => void;
  /** Drops the saved secret for `id`; forgetting the active host moves to the next saved one. */
  forgetHost: (id: string) => void;
}

/* eslint-disable @typescript-eslint/no-empty-function -- intentional no-ops until wave 2 replaces them */
export const noopActions: RelayActions = {
  insertText: async () => {},
  startPairing: () => {},
  submitPin: () => {},
  switchHost: () => {},
  forgetHost: () => {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

export let actions: RelayActions = noopActions;

export function setActions(next: RelayActions): void {
  actions = next;
}
