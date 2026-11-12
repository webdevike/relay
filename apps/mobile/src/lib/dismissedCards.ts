/**
 * Which status cards Isaac closed, as pure functions over the id list the host (or this phone)
 * keeps. A card is named by the id its screen gives it (`canvas:<message id>`, `work:<work id>`,
 * `meeting:<recording id>`, `room:<id>:ready`, `signin:<agent>:<message id>`: the same names Relay
 * desktop uses, so both clients read one set). A card dismissed while its work still runs is kept
 * under `<id>#running` and shows again once the work is done; one dismissed when finished (or by
 * desktop, which has one name per card) stays hidden in every state.
 */
import { DISMISSED_RUNNING_SUFFIX, MAX_DISMISSED_CARDS } from "@relay/protocol";

/** The entry that dismisses card `id` in its current phase. */
export function dismissKey(id: string, running: boolean): string {
  return running ? `${id}${DISMISSED_RUNNING_SUFFIX}` : id;
}

/** Whether card `id` is hidden: dismissed for good, or dismissed while it ran and still running. */
export function isCardHidden(ids: readonly string[], id: string, running: boolean): boolean {
  return ids.includes(id) || (running && ids.includes(`${id}${DISMISSED_RUNNING_SUFFIX}`));
}

/** `ids` with `key` added (newest last); the oldest go past the host's cap. */
export function withDismissed(ids: readonly string[], key: string): string[] {
  return ids.includes(key) ? [...ids] : [...ids, key].slice(-MAX_DISMISSED_CARDS);
}

/** `ids` without `key`. */
export function withRestored(ids: readonly string[], key: string): string[] {
  return ids.filter((other) => other !== key);
}
