import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countOpenTodos } from '../sidebar/todos'
import { appendTodo, isOpenTodoRow, maxTodoId, nextTodoId, parseOpenTodos } from './todos'

const VECTOR_TODOS =
  '# Todos\n\n## Open\n\n- [ ] T6 [flo] a\n- [ ] T65 [relay] b\n\nLives in todos-done.md, cites HTTP2.\n'
const VECTOR_DONE = '- [x] T66 [eva] done\n'

describe('parseOpenTodos', () => {
  it('reads only the Open section, with aliases and added dates', () => {
    const todos =
      '# Todos\n\n- [ ] T1 [flo] stray\n\n## Open\n\n- [ ] T6 [goodword] Ship **iOS** build (added 2026-07-20)\n- [ ] T7 [eva-app] no date here\n- [ ] T8 no tag\n- [ ] X9 [flo] bad id\n\n## Done\n- [ ] T2 [flo] c\n'
    expect(parseOpenTodos(todos)).toEqual([
      { id: 'T6', tag: 'goodops', text: 'Ship iOS build', added: '2026-07-20' },
      { id: 'T7', tag: 'eva-interface', text: 'no date here', added: null },
    ])
  })
  it('agrees with the sidebar count', () => {
    const text =
      '## Open\n- [ ] T3 [flo] Fix (added 2026-10-13)\n- [ ] T4 nope\n- [ ] Q5 [a] x\n- [ ] T6 [a]\n'
    expect(parseOpenTodos(text).length).toBe(countOpenTodos(text))
    expect(isOpenTodoRow('- [ ] T3 [flo] Fix')).toBe(true)
    expect(isOpenTodoRow('- [ ] T4 nope')).toBe(false)
    expect(isOpenTodoRow('- [x] T4 [a] done')).toBe(false)
  })
})

describe('next id and append', () => {
  it('ignores mid word T digits and counts prose ids', () => {
    expect(maxTodoId('HTTP2 and T-rex')).toBe(0)
    expect(maxTodoId('see T12 and xT99 and T7.')).toBe(12)
    expect(nextTodoId(VECTOR_TODOS, VECTOR_DONE)).toBe('T67')
  })
  it('inserts after the last open row', () => {
    const r = appendTodo(VECTOR_TODOS, VECTOR_DONE, 'goodops', ' Ship it ', '2026-10-02')
    expect(r.id).toBe('T67')
    expect(r.row).toBe('- [ ] T67 [goodops] Ship it (added 2026-10-02)')
    expect(r.next).toBe(
      '# Todos\n\n## Open\n\n- [ ] T6 [flo] a\n- [ ] T65 [relay] b\n- [ ] T67 [goodops] Ship it (added 2026-10-02)\n\nLives in todos-done.md, cites HTTP2.\n',
    )
  })
  it('inserts at open+2 without open rows', () => {
    const r = appendTodo('# T\n\n## Open\n\n## Done\n', '', 'eva', 'x', '2026-10-02')
    expect(r.next).toBe('# T\n\n## Open\n\n- [ ] T1 [eva] x (added 2026-10-02)\n## Done\n')
  })
  it('throws invalid-data without ## Open', () => {
    try {
      appendTodo('# T\n', '', 'eva', 'x', '2026-10-02')
      expect.unreachable()
    } catch (e) {
      expect((e as { code?: string }).code).toBe('invalid-data')
    }
  })
  it('collapses newlines and keeps a missing trailing newline missing', () => {
    const r = appendTodo('## Open\n- [ ] T1 [a] x', '', 'eva', 'one\r\ntwo\n\nthree', '2026-10-02')
    expect(r.row).toBe('- [ ] T2 [eva] one two three (added 2026-10-02)')
    expect(r.next).toBe('## Open\n- [ ] T1 [a] x\n- [ ] T2 [eva] one two three (added 2026-10-02)')
  })
})

describe('real files', () => {
  const dir = join(__dirname, '__fixtures__')
  const todos = readFileSync(join(dir, 'real-todos.md'), 'utf8')
  const done = readFileSync(join(dir, 'real-todos-done.md'), 'utf8')
  it('reproduces the Rust numbers (snapshot: T79, 24 open)', () => {
    expect(maxTodoId(todos)).toBe(75)
    expect(maxTodoId(done)).toBe(78)
    expect(nextTodoId(todos, done)).toBe('T79')
    expect(parseOpenTodos(todos)).toHaveLength(24)
    expect(countOpenTodos(todos)).toBe(24)
  })
})
