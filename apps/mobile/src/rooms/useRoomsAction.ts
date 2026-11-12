/**
 * One card's (or one control's) Rooms actions, one at a time, read from the request machine of the
 * last tap through @xstate/react. `view` is what the room frame shows of the thing the actions change
 * (the card as JSON, the room's phase ...): after the desktop's answer the request keeps the card busy
 * until the view moves. While a request is busy or unconfirmed a tap does nothing, so a re-tap cannot
 * post or answer twice; Try again (`retry`) re-sends the same rid.
 */
import { useEffect, useRef, useState } from "react";
import { useSelector } from "@xstate/react";
import type { RoomsCmd, RoomsResult } from "@relay/protocol";
import { roomsRequest } from "@/connection";
import { commandError } from "./model";
import { requestPhase, type RoomsRequest, type RoomsRequestPhase, type RoomsRequestSnapshot } from "./roomsRequest.machine";

interface Current {
  key: string;
  request: RoomsRequest;
}

export interface RoomsAction {
  /** The key of the action in flight (sent, or answered and not shown yet); every action waits for it. */
  busy: string | null;
  /** The key of the action whose answer never came: it shows Not confirmed with Try again. */
  unconfirmed: string | null;
  /** The refusal to show; null unless the last action failed. */
  error: string | null;
  run: (key: string, cmd: RoomsCmd) => void;
  retry: () => void;
}

const selectPhase = (s: RoomsRequestSnapshot | undefined): RoomsRequestPhase | null => (s === undefined ? null : requestPhase(s));
const selectResult = (s: RoomsRequestSnapshot | undefined): RoomsResult | null => s?.context.result ?? null;

export function useRoomsAction(view: string | null, onAnswered?: (result: RoomsResult) => void): RoomsAction {
  const [current, setCurrent] = useState<Current | null>(null);
  // `run` reads this synchronously, so two taps in one frame start one request.
  const latest = useRef<Current | null>(null);
  const answered = useRef(onAnswered);
  useEffect(() => {
    answered.current = onAnswered;
  });
  const phase = useSelector(current?.request, selectPhase);
  const result = useSelector(current?.request, selectResult);

  useEffect(() => {
    if (current !== null && view !== null) current.request.send({ type: "room.changed", view });
  }, [current, view]);

  const run = (key: string, cmd: RoomsCmd): void => {
    const last = latest.current?.request.getSnapshot();
    if (last !== undefined && (requestPhase(last) === "busy" || requestPhase(last) === "unconfirmed")) return;
    const request = roomsRequest(cmd, view);
    let told = false;
    request.subscribe((s) => {
      if (told || !s.matches("answered") || s.context.result === null) return;
      told = true;
      answered.current?.(s.context.result);
    });
    const next = { key, request };
    latest.current = next;
    setCurrent(next);
  };

  return {
    busy: phase === "busy" && current !== null ? current.key : null,
    unconfirmed: phase === "unconfirmed" && current !== null ? current.key : null,
    error: phase === "failed" && result !== null ? commandError(result) : null,
    run,
    retry: () => {
      latest.current?.request.send({ type: "request.retry" });
    },
  };
}
