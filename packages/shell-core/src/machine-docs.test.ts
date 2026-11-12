/**
 * Every XState machine shared by Relay Desktop (shell-core) has a page in `docs/state-machines/`
 * (repo root) whose Mermaid diagram is generated from the machine itself. This fails when a page
 * is missing or its diagram is stale; `UPDATE_MACHINE_DOCS=1 pnpm test` rewrites the diagrams and
 * writes a new page with a TODO where the plain-English lines go. Add a new machine to `MACHINES`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AnyStateMachine } from 'xstate'
import { agentRunMachine } from './agent-run.machine'
import { navHistoryMachine } from './nav-history.machine'
import { machineDiagram, newDoc, withDiagram } from './machine-diagram'

const MACHINES: readonly { file: string; title: string; machine: AnyStateMachine }[] = [
  {
    file: 'agent-run',
    title: "An agent's run on a surface (browser page, canvas board)",
    machine: agentRunMachine,
  },
  {
    file: 'nav-history',
    title: "The window's Back and Forward history (desktop)",
    machine: navHistoryMachine,
  },
]

const DOCS = fileURLToPath(new URL('../../../docs/state-machines/', import.meta.url))
const update = process.env['UPDATE_MACHINE_DOCS'] === '1'

describe('docs/state-machines', () => {
  for (const { file, title, machine } of MACHINES) {
    it(`${file}.md matches the ${machine.id} machine`, () => {
      const path = `${DOCS}${file}.md`
      const diagram = machineDiagram(machine)
      if (!existsSync(path)) {
        if (update) writeFileSync(path, newDoc(title, diagram))
        expect(existsSync(path), `${path} is missing: run UPDATE_MACHINE_DOCS=1 pnpm test`).toBe(
          true,
        )
      }
      const doc = readFileSync(path, 'utf8')
      const next = withDiagram(doc, diagram)
      expect(next, `${path} has no diagram markers`).not.toBeNull()
      if (update && next !== doc && next !== null) writeFileSync(path, next)
      expect(
        readFileSync(path, 'utf8'),
        `${path} is stale: run UPDATE_MACHINE_DOCS=1 pnpm test`,
      ).toBe(next)
      expect(doc.includes('TODO'), `${path} still has a TODO`).toBe(false)
    })
  }
})
