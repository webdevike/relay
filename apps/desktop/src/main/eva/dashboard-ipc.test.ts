import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { makeClock } from '@evaos/eva-core/model/dates'
import { dashboardHandler } from './dashboard-ipc'

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-dash-'))
  fs.mkdirSync(path.join(root, 'workspaces'))
  fs.mkdirSync(path.join(root, 'memory'))
  fs.writeFileSync(path.join(root, 'workspaces', 'flo.md'), '# Flo\n\nA tagline.\n')
  fs.writeFileSync(path.join(root, 'workspaces', 'relay.md'), '# Relay\n\nShip it.\n')
  fs.writeFileSync(path.join(root, 'memory', 'todos.md'), '# Todos\n\n## Open\n\n- [ ] T1 [relay] Do a thing\n')
  fs.writeFileSync(path.join(root, 'memory', 'journal.md'), '')
  return root
}

describe('dashboardHandler', () => {
  it('returns workspaces with the built-in Eva and 90 day arrays at the fixed clock', () => {
    const root = tree()
    try {
      const clock = makeClock('2026-10-15T12:00:00Z', () => Date.parse('2026-10-15T12:00:00Z'))
      const out = dashboardHandler(root, clock)
      expect(out.workspaces.some((w) => w.builtIn)).toBe(true)
      expect(out.workspaces.length).toBe(3)
      for (const w of out.workspaces) expect(w.daily).toHaveLength(90)
      expect(out.todos).toHaveLength(1)
      expect(out.today).toBe(clock.today())
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
