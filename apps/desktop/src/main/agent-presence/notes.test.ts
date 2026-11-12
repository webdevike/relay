import { describe, expect, it } from 'vitest'
import type { AgentNote } from '@evaos/contract'
import { noteOwner } from './notes'

const comment = (assignee?: string): AgentNote => ({
  surface: 'canvas',
  text: 'Make this bigger',
  slug: 'mind-map',
  board: 'Q4 roadmap',
  page: 'page-1',
  thread: 't-1',
  node: { id: 'note-3', title: 'Launch' },
  at: { x: 10, y: 20 },
  reply: false,
  ...(assignee === undefined ? {} : { assignee }),
})

const known = (id: string): boolean => id === 'penny'

describe('note owner', () => {
  it('sends a comment that @mentions an assistant to its thread, over the run', () => {
    expect(noteOwner(comment('penny'), 'chat:/s/b.jsonl', 'chat:/s/a.jsonl', known)).toEqual({
      assistant: 'penny',
    })
  })

  it('sends to the chat whose agent works the board, not the one it is shown in', () => {
    expect(noteOwner(comment('stranger'), 'chat:/s/b.jsonl', 'chat:/s/a.jsonl', known)).toEqual({
      file: '/s/a.jsonl',
    })
  })

  it('falls back to the chat of the workspace, and to no one on a plain page', () => {
    expect(noteOwner(comment(), 'page:agent:nova', null, known)).toEqual({ assistant: 'nova' })
    expect(noteOwner(comment(), 'page:canvas', null, known)).toBeNull()
    expect(noteOwner(comment(), null, null, known)).toBeNull()
  })
})
