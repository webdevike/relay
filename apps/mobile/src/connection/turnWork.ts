/**
 * The work behind an assistant thread's turns on the phone ("peek behind the curtain"): one `assistant.work.req`
 * per sheet fetch, answered by `assistant.work.res` on its rid. Only sent to a host whose `welcome.features`
 * has ASSISTANT_WORK_FEATURE (an older host drops the connection on a frame it doesn't know), and only while
 * Settings' Show work is on: nothing of it rides on the thread's snapshots.
 */
import { create } from "zustand";
import { ASSISTANT_WORK_FEATURE, type ServerMessage } from "@relay/protocol";
import type { WorkAnswer } from "@/agents/turnWork.machine";
import type { PendingQueries } from "./query";

/** How long a sheet waits for the host's answer before it says the Mac did not answer. */
export const WORK_TIMEOUT_MS = 15_000;

/** Whether the connected host answers `assistant.work.req` (from each `welcome`; false between hosts). */
export const useTurnWorkStore = create<{ up: boolean; setUp: (up: boolean) => void }>()((set) => ({
  up: false,
  setUp: (up) => {
    set({ up });
  },
}));

/** Keeps whether the host shows work (each `welcome`) and settles `assistant.work.res` with the host's whole answer. */
export function createTurnWorkFrameRouter(
  pending: PendingQueries,
): (message: ServerMessage) => void {
  return (message) => {
    if (message.t === "welcome")
      useTurnWorkStore
        .getState()
        .setUp(message.features?.includes(ASSISTANT_WORK_FEATURE) === true);
    if (message.t === "assistant.work.res")
      pending.settle(message.rid, { ok: true, data: message });
  };
}

/** The host's answer (`data` an `assistant.work.res`), or the local failure (timeout, disconnect, not sent) as a refused answer. */
export function workAnswerOf(
  answer: { ok: true; data: unknown } | { ok: false; error: string },
): WorkAnswer {
  if (!answer.ok) return { ok: false, error: answer.error };
  // The router above settles a work rid only with the parsed `assistant.work.res` frame itself.
  const res = answer.data as Extract<ServerMessage, { t: "assistant.work.res" }>;
  return {
    ok: res.ok,
    ...(res.work === undefined ? {} : { work: res.work }),
    ...(res.detail === undefined ? {} : { detail: res.detail }),
    ...(res.error === undefined ? {} : { error: res.error }),
  };
}
