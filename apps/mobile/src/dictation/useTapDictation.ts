/**
 * Tap-to-dictate in a composer: a tap on the mic (its press already started listening) turns the
 * field into a live transcript after whatever was typed before. Stop keeps the words for editing,
 * send stops and sends them, the x drops them and the draft is as it was. The words arrive through
 * a `local` dictation target, so nothing reaches the host until the composer sends.
 */
import { useEffect, useRef, useState } from "react";
import { dictationActor } from "./actor";
import { setDictationTarget } from "./deliver";
import { useDictation } from "./useDictation";
import { joinDictation, landDictation, type TapIntent, type TapRun } from "./tapDictation";
import { phaseOf, type DictationPhase } from "./machine";

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
  /** Points dictation back where hold-to-talk sends it (this screen's own target). */
  restoreTarget: () => void;
}

/** Phases a run cannot come back from with words: it lands with what the field showed. */
const DONE: Partial<Record<DictationPhase, true>> = { idle: true, error: true, permission_denied: true };

export function useTapDictation(options: TapDictationOptions): TapDictation {
  const { phase, transcript } = useDictation();
  const [dictating, setDictating] = useState(false);
  const run = useRef<TapRun | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const live = dictating && run.current !== null ? joinDictation(run.current.base, transcript) : options.draft;
  if (dictating && run.current !== null) run.current.interim = live;

  const land = (heard: string | null): void => {
    const current = run.current;
    if (current === null) return;
    run.current = null;
    const out = landDictation(current, heard, latest.current.draft);
    if (out.draft !== undefined) latest.current.setDraft(out.draft);
    if (out.send !== null) latest.current.send(out.send);
    latest.current.restoreTarget();
    setDictating(false);
  };
  const landRef = useRef(land);
  landRef.current = land;

  // Nothing heard, an error, the permission refused or the x: the run ends without delivered words.
  useEffect(() => {
    if (run.current !== null && DONE[phase] === true) landRef.current(null);
  }, [phase]);

  /** Ends listening; the words arrive through the local target, or through the phase effect when there are none. */
  const end = (intent: Exclude<TapIntent, null>): void => {
    const current = run.current;
    if (current === null) return;
    current.intent = intent;
    setDictating(false);
    if (intent === "cancel") {
      latest.current.setDraft(current.base);
      dictationActor.send({ type: "abandon" });
    } else {
      latest.current.setDraft(current.interim);
    }
    // While listening this finishes; still asking for permission, it ends the moment listening opens.
    dictationActor.send({ type: "release" });
  };

  return {
    dictating,
    live,
    begin: () => {
      // The press already ended (permission refused, recognizer failed): there is nothing to keep listening to.
      if (DONE[phaseOf(dictationActor.getSnapshot())] === true) return;
      run.current = { base: latest.current.draft, interim: latest.current.draft, intent: null };
      setDictationTarget({
        kind: "local",
        onText: (heard) => {
          landRef.current(heard);
          return Promise.resolve();
        },
      });
      setDictating(true);
    },
    stop: () => {
      end("keep");
    },
    send: () => {
      end("send");
    },
    cancel: () => {
      end("cancel");
    },
  };
}
