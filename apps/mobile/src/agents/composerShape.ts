/**
 * Every mounted composer's shape actor (`composerShape.machine.ts`), so the OTA gate can ask
 * `composerBusy()` before restarting the app under someone's thumb.
 */
import type { ComposerShapeActor } from "./composerShape.machine";

const mounted = new Set<ComposerShapeActor>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Registers a mounted composer for `composerBusy`; call the result when it unmounts. */
export function trackComposer(actor: ComposerShapeActor): () => void {
  mounted.add(actor);
  const subscription = actor.subscribe(notify);
  notify();
  return () => {
    subscription.unsubscribe();
    mounted.delete(actor);
    notify();
  };
}

/** Whether any mounted composer is open, being typed in, dictating or held. */
export function composerBusy(): boolean {
  for (const actor of mounted) if (!actor.getSnapshot().matches("idle")) return true;
  return false;
}

/** Called whenever a composer changes shape, mounts or unmounts (`composerBusy` may have changed). */
export function subscribeComposerBusy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
