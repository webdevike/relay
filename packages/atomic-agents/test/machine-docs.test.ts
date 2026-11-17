/**
 * The core's XState machines have pages in `docs/state-machines/` (repo root) whose Mermaid diagram is generated from
 * the machine (shell-core's generator). This fails when a page is missing or stale; `UPDATE_MACHINE_DOCS=1 bun test
 * test/machine-docs.test.ts` rewrites the diagrams and starts a new page with a TODO where the plain-English lines go.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { AnyStateMachine } from "xstate";
import { machineDiagram, newDoc, withDiagram } from "../../shell-core/src/machine-diagram.ts";
import { trialMachine } from "../src/core/trial.machine.ts";

const MACHINES: ReadonlyArray<{ file: string; title: string; machine: AnyStateMachine }> = [
  {
    file: "trial",
    title: "One taste agent's blind model trial (atomic-agents trial mode)",
    machine: trialMachine,
  },
];

const DOCS = new URL("../../../docs/state-machines/", import.meta.url).pathname;
const update = process.env["UPDATE_MACHINE_DOCS"] === "1";

describe("docs/state-machines", () => {
  for (const { file, title, machine } of MACHINES) {
    test(`${file}.md matches the ${machine.id} machine`, () => {
      const path = `${DOCS}${file}.md`;
      // shell-core resolves its own copy of xstate's types; the machine is the same shape.
      const diagram = machineDiagram(machine as unknown as Parameters<typeof machineDiagram>[0]);
      if (!existsSync(path) && update) writeFileSync(path, newDoc(title, diagram));
      expect(existsSync(path)).toBe(true);
      const doc = readFileSync(path, "utf8");
      const next = withDiagram(doc, diagram);
      expect(next).not.toBeNull();
      if (update && next !== null && next !== doc) writeFileSync(path, next);
      expect(readFileSync(path, "utf8")).toBe(next!);
      expect(doc.includes("TODO")).toBe(false);
    });
  }
});
