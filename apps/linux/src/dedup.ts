// Port of CommandDedupStore.swift. Dedups `cmd` execution by id, per device, across reconnects:
// a phone retries un-acked commands after reconnecting and must get the original response back
// instead of a re-execution. Keeps the last 256 ids per device, oldest evicted first.

import type { ServerMessage } from "@relay/protocol";
import type { FrameSink } from "./seams";

export type DedupLookup =
  | { readonly kind: "fresh" }
  | { readonly kind: "inFlight" }
  | { readonly kind: "completed"; readonly response: ServerMessage };

interface Entry {
  readonly id: string;
  state: { readonly kind: "inFlight"; readonly waiters: FrameSink[] } | { readonly kind: "completed"; readonly response: ServerMessage };
}

const CAPACITY = 256;

export class CommandDedupStore {
  private readonly byDevice = new Map<string, Entry[]>();

  /**
   * Fresh ids are marked in flight synchronously so a duplicate arriving before `complete` is
   * never re-executed: it registers `waiter` and receives the eventual response.
   */
  begin(deviceId: string, id: string, waiter: FrameSink): DedupLookup {
    const entries = this.byDevice.get(deviceId) ?? [];
    const existing = entries.find((entry) => entry.id === id);
    if (existing !== undefined) {
      if (existing.state.kind === "completed") return { kind: "completed", response: existing.state.response };
      existing.state.waiters.push(waiter);
      return { kind: "inFlight" };
    }
    entries.push({ id, state: { kind: "inFlight", waiters: [] } });
    if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
    this.byDevice.set(deviceId, entries);
    return { kind: "fresh" };
  }

  /** Notifies waiters registered while in flight, then caches `response`. Does not send to the caller. */
  complete(deviceId: string, id: string, response: ServerMessage): void {
    const entry = this.byDevice.get(deviceId)?.find((candidate) => candidate.id === id);
    if (entry === undefined) return;
    if (entry.state.kind === "inFlight") {
      for (const waiter of entry.state.waiters) waiter.send(response);
    }
    entry.state = { kind: "completed", response };
  }
}
