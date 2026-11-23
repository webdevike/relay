/**
 * The host's XState machines have pages in `docs/state-machines/` (repo root) whose Mermaid diagram
 * is generated from the machine (shell-core's generator). This fails when a page is missing or
 * stale; `UPDATE_MACHINE_DOCS=1 pnpm --filter @relay/linux test machine-docs` rewrites the diagrams
 * and starts a new page with a TODO where the plain-English lines go. Add a new machine to
 * `MACHINES`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnyStateMachine } from "xstate";
import {
  machineDiagram,
  newDoc,
  withDiagram,
} from "../../../packages/shell-core/src/machine-diagram";
import { deepgramCallMachine } from "../src/call/deepgramCall.machine";
import { keyMomentsMachine } from "../src/meetings/key-moments.machine";

const MACHINES: readonly { file: string; title: string; machine: AnyStateMachine }[] = [
  { file: "deepgram-call", title: "Deepgram Voice Agent call (host)", machine: deepgramCallMachine },
  { file: "key-moments", title: "Key moments of a live call (host)", machine: keyMomentsMachine },
];

const DOCS = new URL("../../../docs/state-machines/", import.meta.url).pathname;
const update = process.env["UPDATE_MACHINE_DOCS"] === "1";

describe("docs/state-machines (host)", () => {
  for (const { file, title, machine } of MACHINES) {
    it(`${file}.md matches the ${machine.id} machine`, () => {
      const path = `${DOCS}${file}.md`;
      const diagram = machineDiagram(machine);
      if (!existsSync(path) && update) writeFileSync(path, newDoc(title, diagram));
      expect(existsSync(path), `${path} is missing: run with UPDATE_MACHINE_DOCS=1`).toBe(true);
      const doc = readFileSync(path, "utf8");
      const next = withDiagram(doc, diagram);
      expect(next, `${path} has no diagram markers`).not.toBeNull();
      if (update && next !== null && next !== doc) writeFileSync(path, next);
      expect(readFileSync(path, "utf8"), `${path} is stale: run with UPDATE_MACHINE_DOCS=1`).toBe(
        next,
      );
      expect(doc.includes("TODO"), `${path} still has a TODO`).toBe(false);
    });
  }
});
