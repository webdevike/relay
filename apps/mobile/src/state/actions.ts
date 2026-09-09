/**
 * Screens call `actions.*` directly. Wave 2 (connection/agents/dictation) replaces the
 * implementations at runtime via `setActions` once the real transport exists; until then every
 * action is a no-op so every screen renders and is interactive without a live connection.
 */
export interface RelayActions {
  sendReply: (sessionId: string, text: string) => Promise<void>;
  insertText: (text: string) => Promise<void>;
  startPairing: () => void;
  submitPin: (pin: string) => void;
  forgetMac: () => void;
}

/* eslint-disable @typescript-eslint/no-empty-function -- intentional no-ops until wave 2 replaces them */
export const noopActions: RelayActions = {
  sendReply: async () => {},
  insertText: async () => {},
  startPairing: () => {},
  submitPin: () => {},
  forgetMac: () => {},
};
/* eslint-enable @typescript-eslint/no-empty-function */

export let actions: RelayActions = noopActions;

export function setActions(next: RelayActions): void {
  actions = next;
}
