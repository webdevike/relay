import { useGateStore } from "@/state/gate";
import { sendCommand } from "@/connection";
import { GateCard } from "./GateCard";

/**
 * The gate card while the host's habit gate is locked; nothing otherwise. Every action goes to
 * the host as a command, and the card follows the `gate.status` the host pushes back.
 */
export function HabitGate() {
  const gate = useGateStore((state) => state.gate);
  if (gate?.locked !== true) return null;
  return (
    <GateCard
      // A started or finished timer is a new step: the card starts clean (selection, photo, error).
      key={gate.active === null ? "pick" : `${gate.active.kind}:${gate.active.id}:${gate.active.startedAt}`}
      gate={gate}
      onStart={(id) => sendCommand({ kind: "gate.start", id })}
      onDone={(id, photo) => sendCommand({ kind: "gate.done", id, ...(photo === undefined ? {} : { photo }) })}
      onOverride={(reason) => sendCommand({ kind: "gate.override", reason })}
    />
  );
}
