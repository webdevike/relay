// The quiet bar at the top center of the board: who is in the room, and what each agent is doing
// right now (thinking, editing the board, running a tool, waiting on a handoff, idle), with a
// "done" beat when one finishes. It is always there while the room is live, so you never have to
// guess whether anything is happening. Clicking it opens the side log. It never moves the camera.
import {
  IconCheck,
  IconHourglass,
  IconPencil,
  IconSparkles,
  IconTool,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { DoneTracker, type Person, type PersonState, describeRoom, useWidgetsLoading } from "./activity";
import { Face } from "./avatar";
import { useConnection, useThrottledPresence } from "./hooks";
import { LOCAL_ORIGIN } from "./model";
import { provider, yNodes } from "./room";

/** A burst of added cards is counted until this long passes without another. */
const BURST_MS = 3000;
/** While an agent holds its last line or reads "done", the bar re-renders this often to move it on. */
const TICK_MS = 400;

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

function StateIcon({ state }: { state: PersonState }) {
  const props = { size: 14, stroke: 1.75, "aria-hidden": true } as const;
  if (state === "thinking") return <IconSparkles {...props} />;
  if (state === "editing") return <IconPencil {...props} />;
  if (state === "tool") return <IconTool {...props} />;
  if (state === "waiting") return <IconHourglass {...props} />;
  if (state === "done") return <IconCheck {...props} />;
  return <span className="cv-who-dot" aria-hidden="true" />;
}

function Who({ person }: { person: Person }) {
  return (
    <span
      className="cv-who"
      data-testid="canvas-who"
      data-name={person.name}
      data-agent={person.agent ? "true" : undefined}
      data-state={person.agent ? person.state : undefined}
      title={person.agent ? `${person.name}, ${person.label}` : person.name}
    >
      <Face
        who={{ name: person.name, color: person.color, kind: person.agent ? "agent" : "human", avatar: person.avatar }}
        size={20}
        ring={person.agent}
        className="cv-who-avatar"
      />
      <span className="cv-who-name">{person.name}</span>
      {person.agent ? (
        <span className="cv-who-state">
          <StateIcon state={person.state} />
          <span className="cv-who-label">{person.label}</span>
        </span>
      ) : null}
    </span>
  );
}

export function RoomBar({ onOpen }: { onOpen: () => void }) {
  const presences = useThrottledPresence();
  const added = useAddedBurst();
  const widgetsLoading = useWidgetsLoading();
  const connection = useConnection();
  const tracker = useRef(new DoneTracker());
  const [, tick] = useState(0);
  const people = tracker.current.apply(describeRoom(presences.values(), added), Date.now());
  const pending = tracker.current.pending;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [pending]);
  if (connection !== "live" || people.length === 0) return null;
  return (
    <button
      type="button"
      className="cv-roombar"
      data-testid="canvas-roombar"
      title="Open the activity log"
      onClick={onOpen}
    >
      {people.map((person) => (
        <Who key={person.key} person={person} />
      ))}
      {widgetsLoading > 0 ? (
        <span className="cv-who cv-who-widgets">
          <span className="cv-who-dot" aria-hidden="true" />
          Live widgets refreshing
        </span>
      ) : null}
    </button>
  );
}
