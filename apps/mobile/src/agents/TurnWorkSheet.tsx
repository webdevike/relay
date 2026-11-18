/**
 * The work sheet of an assistant thread ("peek behind the curtain"): the bottom sheet a reply's brain
 * (`WorkBrain`) opens, over the thread (`ui/OverlaySheet`). `useTurnWork` runs its machine
 * (`turnWork.machine.ts`) against the host (`requestTurnWork`); the sheet draws `TurnWorkView` from its state.
 */
import { useEffect, useMemo } from "react";
import { useActorRef, useSelector } from "@xstate/react";
import { fromCallback, fromPromise, type ActorRefFrom } from "xstate";
import { requestTurnWork } from "@/connection";
import { useSecondClock } from "@/lib/useSecondClock";
import { OverlaySheet } from "@/ui/OverlaySheet";
import {
  turnWorkMachine,
  type DetailInput,
  type TurnWorkEvent,
  type TurnWorkSnapshot,
  type WorkTarget,
} from "./turnWork.machine";
import { TurnWorkBody, TurnWorkHeader, type SheetState } from "./TurnWorkView";

export type TurnWorkActor = ActorRefFrom<typeof turnWorkMachine>;

/** The sheet machine against the host. `rev` is the thread's snapshot rev: a running turn asks again on each one. */
export function useTurnWork(rev: number | undefined): TurnWorkActor {
  const machine = useMemo(
    () =>
      turnWorkMachine.provide({
        actors: {
          fetchWork: fromPromise(({ input }: { input: WorkTarget }) => requestTurnWork(input)),
          fetchDetail: fromCallback<TurnWorkEvent, DetailInput>(({ input, sendBack }) => {
            void requestTurnWork(input.target, input.id).then((answer) => {
              sendBack(
                answer.ok && answer.detail !== undefined
                  ? {
                      type: "detail.loaded",
                      id: input.id,
                      generation: input.generation,
                      detail: answer.detail,
                    }
                  : {
                      type: "detail.failed",
                      id: input.id,
                      generation: input.generation,
                      error: answer.error ?? "Nothing more to show.",
                    },
              );
            });
          }),
        },
      }),
    [],
  );
  const actor = useActorRef(machine);
  useEffect(() => {
    actor.send({ type: "thread.changed" });
  }, [actor, rev]);
  return actor;
}

/** Opens the sheet on `target`'s turn. */
export function openTurnWork(actor: TurnWorkActor, target: WorkTarget): void {
  actor.send({ type: "sheet.open", target });
}

const selectSheet = (snapshot: TurnWorkSnapshot): SheetState | null =>
  snapshot.matches("closed")
    ? null
    : snapshot.matches("loading")
      ? "loading"
      : snapshot.matches("failed")
        ? "failed"
        : "shown";
const selectWork = (snapshot: TurnWorkSnapshot) => snapshot.context.work;
const selectError = (snapshot: TurnWorkSnapshot) => snapshot.context.error;
const selectParts = (snapshot: TurnWorkSnapshot) => snapshot.context.parts;
const selectOpen = (snapshot: TurnWorkSnapshot) => snapshot.context.open;

export function TurnWorkSheet({ actor }: { actor: TurnWorkActor }) {
  const state = useSelector(actor, selectSheet);
  const work = useSelector(actor, selectWork);
  const error = useSelector(actor, selectError);
  const parts = useSelector(actor, selectParts);
  const open = useSelector(actor, selectOpen);
  // The elapsed clock and a running step's time tick each second, only while the sheet shows a running turn.
  const now = useSecondClock(state !== null && work?.running === true);
  const close = () => {
    actor.send({ type: "sheet.close" });
  };
  return (
    <OverlaySheet
      open={state !== null}
      onClose={close}
      header={<TurnWorkHeader state={state ?? "loading"} work={work} now={now} />}
    >
      {state !== null && (
        <TurnWorkBody
          state={state}
          work={work}
          error={error}
          parts={parts}
          open={open}
          now={now}
          onToggle={(id) => {
            actor.send({ type: "part.toggle", id });
          }}
          onRetry={() => {
            actor.send({ type: "sheet.retry" });
          }}
        />
      )}
    </OverlaySheet>
  );
}
