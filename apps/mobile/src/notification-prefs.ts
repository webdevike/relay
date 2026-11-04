/**
 * The assistants this phone gets no pushes from (`mutedAssistants` in settings, sent to the host as
 * `push.prefs`). Kept free of expo modules so it is testable on its own.
 */

/** `muted` with `agent` added (`mute`) or removed; the same list, order kept, when nothing changes. */
export function withMuted(muted: readonly string[], agent: string, mute: boolean): string[] {
  const has = muted.includes(agent);
  if (mute === has) return [...muted];
  return mute ? [...muted, agent] : muted.filter((id) => id !== agent);
}
