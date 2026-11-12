/**
 * Every XState machine of the phone has a page in `docs/state-machines/` (repo root) whose Mermaid
 * diagram is generated from the machine itself. This fails when a page is missing or its diagram is
 * stale; `pnpm machines:docs` (UPDATE_MACHINE_DOCS=1) rewrites the diagrams, and writes a new page
 * with a TODO where the plain-English lines go. Add a new machine to `MACHINES`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnyStateMachine } from "xstate";
import { machineDiagram, newDoc, withDiagram } from "./lib/machineDiagram";
import { commandMachine } from "./connection/command.machine";
import { sessionMachine } from "./connection/session.machine";

const MACHINES: readonly { file: string; title: string; machine: AnyStateMachine }[] = [
  { file: "command", title: "Reliable command lifecycle (phone to host)", machine: commandMachine },
  { file: "session", title: "Connection session (discovery, pairing, heartbeat, backoff, background)", machine: sessionMachine },
];

const DOCS = fileURLToPath(new URL("../../../docs/state-machines/", import.meta.url));
const update = process.env["UPDATE_MACHINE_DOCS"] === "1";

describe("docs/state-machines", () => {
  for (const { file, title, machine } of MACHINES) {
    it(`${file}.md matches the ${machine.id} machine`, () => {
      const path = `${DOCS}${file}.md`;
      const diagram = machineDiagram(machine);
      if (!existsSync(path)) {
        if (update) writeFileSync(path, newDoc(title, diagram));
        expect(existsSync(path), `${path} is missing: run pnpm machines:docs`).toBe(true);
      }
      const doc = readFileSync(path, "utf8");
      const next = withDiagram(doc, diagram);
      expect(next, `${path} has no diagram markers`).not.toBeNull();
      if (update && next !== doc && next !== null) writeFileSync(path, next);
      expect(readFileSync(path, "utf8"), `${path} is stale: run pnpm machines:docs`).toBe(next);
      expect(doc.includes("TODO"), `${path} still has a TODO`).toBe(false);
    });
  }
});
