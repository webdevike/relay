// The quiet status pill at the top center of the board: who is doing what in the background
// ("Nova is thinking…", "Nova is adding 3 cards", "Waiting on Nova: screenshots (handoff)", "Live
// widgets refreshing"), an animated dot while something is working, gone when idle. Clicking it
// opens the side log. It never moves the camera.
import { useEffect, useState } from "react";
import { type Activity, describeActivity, useWidgetsLoading } from "./activity";
import { avatarUrl } from "./env";
import { useConnection, useThrottledPresence } from "./hooks";
import { LOCAL_ORIGIN } from "./model";
import { env, provider, yNodes } from "./room";

/** The pill stays this long after its state ends, so quick steps read as one calm line. */
const HOLD_MS = 1200;
/** A burst of added cards is counted until this long passes without another. */
const BURST_MS = 3000;

/** Cards added by others since the last quiet gap (the first sync, which loads the whole board, is not a burst). */
function useAddedBurst(): number {
  const [added, setAdded] = useState(0);
  useEffect(() => {
    let timer: number | undefined;
    const onAdd = (e: {
      transaction: { origin: unknown };
      changes: { keys: Map<string, { action: string }> };
    }) => {
      if (!provider.synced || e.transaction.origin === LOCAL_ORIGIN) return;
      let n = 0;
      for (const change of e.changes.keys.values()) if (change.action === "add") n++;
      if (n === 0) return;
      setAdded((a) => a + n);
      clearTimeout(timer);
      timer = window.setTimeout(() => setAdded(0), BURST_MS);
    };
    yNodes.observe(onAdd);
    return () => {
      yNodes.unobserve(onAdd);
      clearTimeout(timer);
    };
  }, []);
  return added;
}

export function ActivityPill({ onOpen }: { onOpen: () => void }) {
  const presences = useThrottledPresence();
  const added = useAddedBurst();
  const widgetsLoading = useWidgetsLoading();
  const connection = useConnection();
  const live = describeActivity({ presences: presences.values(), added, widgetsLoading });
  const [shown, setShown] = useState<Activity | null>(null);
  const liveKey = live === null ? null : `${live.text}|${String(live.working)}`;
  useEffect(() => {
    if (live !== null) {
      setShown(live);
      return;
    }
    const t = setTimeout(() => setShown(null), HOLD_MS);
    return () => clearTimeout(t);
    // `live` is rebuilt every render; its content is liveKey.
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content
  }, [liveKey]);
  if (shown === null || connection !== "live") return null;
  return (
    <button
      type="button"
      className="cv-activity"
      data-testid="canvas-activity"
      data-working={shown.working ? "true" : undefined}
      title="Open the activity log"
      onClick={onOpen}
    >
      {shown.avatar ? (
        <img className="cv-activity-avatar" src={avatarUrl(env, shown.avatar)} alt="" />
      ) : shown.color ? (
        <span className="cv-activity-swatch" style={{ background: shown.color }} />
      ) : null}
      <span className="cv-activity-text">{shown.text}</span>
      <span className="cv-activity-dot" aria-hidden="true" />
    </button>
  );
}
