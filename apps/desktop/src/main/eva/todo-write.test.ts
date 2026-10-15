import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEvaFs } from '@evaos/eva-core'
import { appendTodoVia, knownTags } from './todo-write'
import { addTodoHandler } from './todo-ipc'

const TODOS = '# Todos\n\n## Open\n\n- [ ] T1 [relay] First\n- [ ] T11 [flo] Second\n\n## Notes\n\nx\n'

function tree(todos: string | null = TODOS, done: string | null = '- [x] T15 [flo] Done (added 2026-01-01)\n'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-todo-'))
  fs.mkdirSync(path.join(root, 'memory'))
  fs.mkdirSync(path.join(root, 'workspaces'))
  fs.writeFileSync(path.join(root, 'workspaces', 'relay.md'), '# Relay\n')
  fs.writeFileSync(path.join(root, 'workspaces', 'flo.md'), '# Flo\n')
  if (todos !== null) fs.writeFileSync(path.join(root, 'memory', 'todos.md'), todos)
  if (done !== null) fs.writeFileSync(path.join(root, 'memory', 'todos-done.md'), done)
  return root
}
const read = (root: string): string => fs.readFileSync(path.join(root, 'memory', 'todos.md'), 'utf8')
const rm = (root: string): void => fs.rmSync(root, { recursive: true, force: true })

describe('appendTodoVia', () => {
  it('appends right after the last open row with the next id from both files', async () => {
    const root = tree()
    try {
      const r = await appendTodoVia(createEvaFs({ root }), root, 'relay', 'Ship it', '2026-10-15')
      expect(r.id).toBe('T16')
      expect(read(root)).toBe(
        TODOS.replace('- [ ] T11 [flo] Second\n', '- [ ] T11 [flo] Second\n- [ ] T16 [relay] Ship it (added 2026-10-15)\n'),
      )
    } finally {
      rm(root)
    }
  })

  it('gives concurrent appends distinct ids', async () => {
    const root = tree()
    try {
      const evaFs = createEvaFs({ root })
      const [a, b] = await Promise.all([
        appendTodoVia(evaFs, root, 'relay', 'A', '2026-10-15'),
        appendTodoVia(evaFs, root, 'flo', 'B', '2026-10-15'),
      ])
      expect([a.id, b.id].sort()).toEqual(['T16', 'T17'])
    } finally {
      rm(root)
    }
  })

  it('rejects without ## Open, a missing todos.md; missing done file is empty', async () => {
    const bad = tree('# Todos\n\n- [ ] T1 [x] y\n')
    const missing = tree(null)
    const nodone = tree(TODOS, null)
    try {
      await expect(appendTodoVia(createEvaFs({ root: bad }), bad, 'relay', 'x', '2026-10-15')).rejects.toMatchObject({ code: 'invalid-data' })
      expect(read(bad)).toBe('# Todos\n\n- [ ] T1 [x] y\n')
      await expect(appendTodoVia(createEvaFs({ root: missing }), missing, 'relay', 'x', '2026-10-15')).rejects.toMatchObject({ code: 'not-found' })
      const r = await appendTodoVia(createEvaFs({ root: nodone }), nodone, 'relay', 'x', '2026-10-15')
      expect(r.id).toBe('T12')
    } finally {
      rm(bad)
      rm(missing)
      rm(nodone)
    }
  })
})

describe('tags and handler', () => {
  it('knownTags has workspaces plus eva; add rejects unknown tags and collapses newlines', async () => {
    const root = tree()
    try {
      expect([...knownTags(root)].sort()).toEqual(['eva', 'flo', 'relay'])
      const ctx = { env: { evaRoot: root } } as never
      await expect(addTodoHandler(ctx, { tag: 'nope', text: 'x' })).rejects.toMatchObject({ code: 'invalid-input' })
      const r = await addTodoHandler(ctx, { tag: 'eva', text: 'one\n## two\r\nthree' })
      expect(r.row).toMatch(/^- \[ \] T16 \[eva\] one ## two three \(added \d{4}-\d{2}-\d{2}\)$/)
      expect(read(root).split('\n').filter((l) => l.includes('two')).length).toBe(1)
    } finally {
      rm(root)
    }
  })
})
