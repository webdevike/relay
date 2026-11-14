/**
 * Every XState machine of the desktop app has a page in `docs/state-machines/` (repo root) whose
 * Mermaid diagram is generated from the machine itself (the phone's are in
 * apps/mobile/src/machineDocs.test.ts). This fails when a page is missing or its diagram is stale;
 * `pnpm machines:docs` (UPDATE_MACHINE_DOCS=1) rewrites the diagrams and writes a new page with a
 * TODO where the plain-English lines go. Add a new machine to `MACHINES`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AnyStateMachine } from 'xstate'
import { machineDiagram, newDoc, withDiagram } from '../renderer/lib/machine-diagram'
import { designModeMachine } from '../renderer/browser/design/design-mode.machine'
import { mediaSlotMachine } from '../renderer/chat/widgets/media-slot.machine'

const MACHINES: readonly { file: string; title: string; machine: AnyStateMachine }[] = [
  { file: 'design-mode', title: 'Design Mode in a page tab (desktop)', machine: designModeMachine },
  { file: 'media-slot', title: 'Chat media load order (desktop)', machine: mediaSlotMachine },
]

// Vitest runs in apps/desktop.
const DOCS = resolve(process.cwd(), '../../docs/state-machines') + '/'
const update = process.env['UPDATE_MACHINE_DOCS'] === '1'

describe('docs/state-machines (desktop)', () => {
  for (const { file, title, machine } of MACHINES) {
    it(`${file}.md matches the ${machine.id} machine`, () => {
      const path = `${DOCS}${file}.md`
      const diagram = machineDiagram(machine)
      if (!existsSync(path)) {
        if (update) writeFileSync(path, newDoc(title, diagram))
        expect(existsSync(path), `${path} is missing: run pnpm machines:docs`).toBe(true)
      }
      const doc = readFileSync(path, 'utf8')
      const next = withDiagram(doc, diagram)
      expect(next, `${path} has no diagram markers`).not.toBeNull()
      if (update && next !== doc && next !== null) writeFileSync(path, next)
      expect(readFileSync(path, 'utf8'), `${path} is stale: run pnpm machines:docs`).toBe(next)
      expect(doc.includes('TODO'), `${path} still has a TODO`).toBe(false)
    })
  }
})
