/**
 * Tap-to-dictate in a composer: a tap on the mic (its press already started listening) turns the
 * field into a live transcript after whatever was typed before. Stop keeps the words for editing,
 * send stops and sends them, the x drops them and the draft is as it was. The run lives in the
 * dictation machine's `tap` region; this hook only reads what the field shows and sends the taps.
 * The words land in this composer's own sink, so nothing reaches the host until the composer sends.
 */
import { useRef, useState } from "react";
import { useSelector } from "@xstate/react";
import { dictationActor } from "./actor";
import type { TapSink } from "./machine";

export interface TapDictation {
  /** Listening after a tap: the field shows `live`, the composer shows x, level, stop and send. */
  dictating: boolean;
  /** The draft before the tap plus what has been heard so far; the draft itself when not dictating. */
  live: string;
  /** The mic was tapped: its press already started listening; keep going after the finger lifts. */
  begin: () => void;
  stop: () => void;
  send: () => void;
  cancel: () => void;
}

export interface TapDictationOptions {
  draft: string;
  setDraft: (text: string) => void;
  /** Sends a finished dictation as the composer's turn. */
  send: (text: string) => void;
}

export function useTapDictation(options: TapDictationOptions): TapDictation {
  const latest = useRef(options);
  latest.current = options;
  // One sink for the composer's life: the machine tells this composer's run from another's by it.
  const [sink] = useState<TapSink>(() => ({
    draft: () => latest.current.draft,
    setDraft: (text) => {
      latest.current.setDraft(text);
    },
    send: (text) => {
      latest.current.send(text);
    },
  }));
  const interim = useSelector(dictationActor, (snapshot) =>
    snapshot.matches({ tap: "running" }) && snapshot.context.tap?.sink === sink ? snapshot.context.tap.interim : null,
  );

  return {
    dictating: interim !== null,
    live: interim ?? options.draft,
    begin: () => {
      dictationActor.send({ type: "tapBegin", base: latest.current.draft, sink });
    },
    stop: () => {
      dictationActor.send({ type: "tapEnd", intent: "keep" });
    },
    send: () => {
      dictationActor.send({ type: "tapEnd", intent: "send" });
    },
    cancel: () => {
      dictationActor.send({ type: "tapEnd", intent: "cancel" });
    },
  };
}
