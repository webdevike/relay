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
import { agentFollowMachine } from '../renderer/files/markdown/agent-follow.machine'
import { mediaSlotMachine } from '../renderer/chat/widgets/media-slot.machine'
import { modelViewerMachine } from '../renderer/chat/widgets/rich/model-viewer.machine'
import { protoFrameMachine } from '../renderer/canvas/cards/proto-frame.machine'
import { cardGenMachine } from '../renderer/canvas/agent/card-gen.machine'
import { shareSnapshotsMachine } from './meetings/share-snapshots.machine'
import { cardStackMachine } from '../renderer/chat/stack/card-stack.machine'
import { cardMoveMachine } from '../renderer/agents-board/card-move.machine'
import { prMergeMachine } from '../renderer/reviews/pr-merge.machine'
import { assistantAskMachine } from '../renderer/tickets/assistant-ask.machine'
import { timelinePlanMachine } from '../renderer/agents-board/timeline/plan.machine'

const MACHINES: readonly { file: string; title: string; machine: AnyStateMachine }[] = [
  {
    file: 'agent-follow',
    title: 'Live agent edits in rendered Markdown (desktop Files)',
    machine: agentFollowMachine,
  },
  { file: 'design-mode', title: 'Design Mode in a page tab (desktop)', machine: designModeMachine },
  { file: 'media-slot', title: 'Chat media load order (desktop)', machine: mediaSlotMachine },
  {
    file: 'chat-model-viewer',
    title: 'Chat 3D model, poster until clicked (desktop)',
    machine: modelViewerMachine,
  },
  {
    file: 'card-gen',
    title: 'Card generation states on the canvas (desktop)',
    machine: cardGenMachine,
  },
  {
    file: 'proto-frame',
    title: 'Live component card page on the canvas (desktop)',
    machine: protoFrameMachine,
  },
  {
    file: 'share-snapshots',
    title: 'Screen-share snapshots per recording (desktop)',
    machine: shareSnapshotsMachine,
  },
  {
    file: 'card-stack-desktop',
    title: 'Card stack on the composer: asks and running sessions (desktop)',
    machine: cardStackMachine,
  },
  {
    file: 'card-move',
    title: 'Dragging a Board card to another column (desktop)',
    machine: cardMoveMachine,
  },
  {
    file: 'pr-merge',
    title: 'Merging a pull request from its page (desktop)',
    machine: prMergeMachine,
  },
  {
    file: 'assistant-ask',
    title: 'A private ask to an assistant on a ticket (desktop)',
    machine: assistantAskMachine,
  },
  {
    file: 'timeline-plan',
    title: 'Timeline drafts, Astra re-plan and Apply (desktop)',
    machine: timelinePlanMachine,
  },
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
