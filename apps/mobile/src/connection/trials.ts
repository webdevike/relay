/**
 * Routes the host's trial frames into the trials store: `welcome` says whether it keeps trials
 * (`welcome.features`), `trials.snapshot` (the answer to `trials.get`, pushed to every device on
 * every change) replaces the cards and switch messages, and `trial.picked` / `trial.undone` answer
 * this phone's pick and undo.
 */
import type { ServerMessage } from "@relay/protocol";
import type { TrialsStore } from "@/state/trials";

export type TrialFrameRouter = (message: ServerMessage) => void;

export function createTrialFrameRouter(
  store: Pick<TrialsStore, "setFeatures" | "apply" | "picked" | "undone">,
): TrialFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome") store.setFeatures(message.features);
    else if (message.t === "trials.snapshot")
      store.apply({ trials: message.trials, switches: message.switches });
    else if (message.t === "trial.picked") store.picked(message.trial, message.ok, message.error);
    else if (message.t === "trial.undone") store.undone(message.switch, message.ok, message.error);
  };
}
