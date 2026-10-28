// One live canvas room: the board's Y.Doc and the y-protocols Awareness, synced with every web
// client over the y-websocket wire protocol (sync step 1/2 + updates, awareness, query awareness),
// so the stock `y-websocket` provider in the browser talks to it unchanged. Transport-free: the
// server hands each socket in as a `CanvasPeer`.

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Presence } from "@relay/canvas-live/shared";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

/** One websocket into the room. */
export interface CanvasPeer {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function frame(type: number, write: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}

export class CanvasSync {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  /** Each peer and the awareness client ids it introduced (removed when it leaves). */
  private readonly peers = new Map<CanvasPeer, Set<number>>();
  /** The set of human names changed (someone joined or left). */
  onHumans: ((humans: readonly string[]) => void) | null = null;
  private humanKey = "";

  constructor() {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // The host's own client never times out: the agent's presence lives as long as the room.
    this.awareness.setLocalState(null);
    this.doc.on("update", (update: Uint8Array) => {
      const msg = frame(MSG_SYNC, (e) => {
        syncProtocol.writeUpdate(e, update);
      });
      for (const peer of this.peers.keys()) peer.send(msg);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const ids = origin === null ? undefined : this.peers.get(origin as CanvasPeer);
      if (ids !== undefined) {
        for (const id of added) ids.add(id);
        for (const id of removed) ids.delete(id);
      }
      const changed = [...added, ...updated, ...removed];
      const msg = frame(MSG_AWARENESS, (e) => {
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      });
      for (const peer of this.peers.keys()) peer.send(msg);
      this.reportHumans();
    });
  }

  get peerCount(): number {
    return this.peers.size;
  }

  /** Names of the humans present now, in join order. */
  humans(): string[] {
    const out: string[] = [];
    for (const [cid, state] of this.awareness.getStates() as Map<number, Partial<Presence>>) {
      if (cid !== this.awareness.clientID && state.user?.kind === "human") out.push(state.user.name);
    }
    return out;
  }

  connect(peer: CanvasPeer): void {
    this.peers.set(peer, new Set());
    peer.send(
      frame(MSG_SYNC, (e) => {
        syncProtocol.writeSyncStep1(e, this.doc);
      }),
    );
    const states = [...this.awareness.getStates().keys()];
    if (states.length > 0) {
      peer.send(
        frame(MSG_AWARENESS, (e) => {
          encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
        }),
      );
    }
  }

  receive(peer: CanvasPeer, data: Uint8Array): void {
    if (!this.peers.has(peer)) return;
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, e, this.doc, peer);
        if (encoding.length(e) > 1) peer.send(encoding.toUint8Array(e));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), peer);
      } else if (type === MSG_QUERY_AWARENESS) {
        peer.send(
          frame(MSG_AWARENESS, (e) => {
            encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]));
          }),
        );
      }
    } catch {
      peer.close(1003, "malformed frame");
    }
  }

  disconnect(peer: CanvasPeer): void {
    const ids = this.peers.get(peer);
    if (ids === undefined) return;
    this.peers.delete(peer);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
  }

  /** Closes every peer (the room is unloading). */
  closeAll(code: number, reason: string): void {
    for (const peer of [...this.peers.keys()]) {
      this.disconnect(peer);
      peer.close(code, reason);
    }
  }

  /** Stops the awareness timer and frees the doc; the sync is unusable afterwards. */
  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }

  private reportHumans(): void {
    const humans = this.humans();
    const key = humans.join("\n");
    if (key === this.humanKey) return;
    this.humanKey = key;
    this.onHumans?.(humans);
  }
}
