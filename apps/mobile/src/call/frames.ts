/**
 * Routes the host's `call.*` frames for the call on this phone: `call.state` into the call store,
 * `call.audio` to the player in order, `call.flush` (barge-in) to the player's flush. Audio of a
 * generation below the last flush is late audio of what Isaac talked over, and is dropped. Frames
 * of any other call are ignored.
 */
import type { ServerMessage } from "@relay/protocol";
import type { ActiveCall, CallStore } from "@/state/call";

export interface CallPlayer {
  /** PCM16 LE mono 24 kHz, base64, after what is queued. */
  play(pcm: string): void;
  /** Stop now and drop what is queued. */
  flush(): void;
}

export type CallStoreAccess = Pick<CallStore, "update"> & { readonly current: () => ActiveCall | null };

export type CallFrameRouter = (message: ServerMessage) => void;

export function createCallFrameRouter(store: CallStoreAccess, player: CallPlayer): CallFrameRouter {
  let callId: string | null = null;
  let minGen = 0;
  return (message) => {
    if (message.t !== "call.state" && message.t !== "call.audio" && message.t !== "call.flush") return;
    const call = store.current();
    if (call?.id !== message.callId || call.state === "ended") return;
    if (callId !== call.id) {
      callId = call.id;
      minGen = 0;
    }
    if (message.t === "call.state") {
      store.update(call.id, { state: message.state, text: message.text ?? null, error: message.error ?? null });
      return;
    }
    if (message.t === "call.flush") {
      minGen = Math.max(minGen, message.gen);
      player.flush();
      return;
    }
    if (message.gen >= minGen) player.play(message.pcm);
  };
}
