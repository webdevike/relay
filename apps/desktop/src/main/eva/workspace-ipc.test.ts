import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { makeClock } from '@evaos/eva-core/model/dates'
import { openWorkspaceFile, workspaceHandler } from './workspace-ipc'

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-ws-'))
  fs.mkdirSync(path.join(root, 'workspaces'))
  fs.mkdirSync(path.join(root, 'memory'))
  fs.writeFileSync(
    path.join(root, 'workspaces', 'flo.md'),
    '# Flo\n\nA tagline.\n\n## Threads\n\n- 2026-10-14 first note\n- 2026-10-15 second note\n\n## Notes\n\nBody text\n',
  )
  fs.writeFileSync(path.join(root, 'memory', 'todos.md'), '# Todos\n\n## Open\n\n')
  fs.writeFileSync(path.join(root, 'memory', 'journal.md'), '')
  return root
}
const clock = makeClock('2026-10-15T12:00:00Z', () => Date.parse('2026-10-15T12:00:00Z'))

describe('workspace ipc', () => {
  it('returns detail with newest-first timeline and sections, null for unknown', () => {
    const root = tree()
    try {
      const d = workspaceHandler(root, 'flo', clock)
      expect(d.workspace?.id).toBe('flo')
      expect(d.timeline.map((t) => t.date)).toEqual(['2026-10-15', '2026-10-14'])
      expect(d.sections.find((s) => s.title === 'Notes')?.body).toContain('Body text')
      expect(workspaceHandler(root, 'nope', clock).workspace).toBeNull()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the file in main and rejects the built-in', async () => {
    const root = tree()
    try {
      const ctx = { env: { evaRoot: root, e2e: false } } as never
      const seen: string[] = []
      await openWorkspaceFile(ctx, 'flo', async (p) => (seen.push(p), ''))
      expect(seen).toEqual([fs.realpathSync(path.join(root, 'workspaces', 'flo.md'))])
      await expect(openWorkspaceFile(ctx, 'eva')).rejects.toMatchObject({ code: 'no-file' })
      await expect(openWorkspaceFile(ctx, 'nope')).rejects.toMatchObject({ code: 'no-file' })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
