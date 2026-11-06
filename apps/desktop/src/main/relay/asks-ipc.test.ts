import { describe, expect, it } from 'vitest'
import { asksOf } from './asks-ipc'

const open = {
  id: 'abcdef01',
  source: 'replies',
  label: 'Push it?',
  question: 'Push it to prod?',
  replies: ['Yes', 'No'],
  at: 5,
  messageId: 'a1',
  sessionId: 'unused-by-desktop',
}

describe('asksOf', () => {
  it('reads an assistant snapshot, dropping a malformed ask', () => {
    const view = asksOf({
      t: 'assistant.snapshot',
      agent: 'nova',
      snapshot: { rev: 1, messages: [], busy: false, sessionId: '', asks: [open, { id: 'x' }] },
    })
    expect(view?.agent).toBe('nova')
    expect(view?.asks).toHaveLength(1)
    expect(view?.asks?.[0]).toMatchObject({ id: 'abcdef01', label: 'Push it?', messageId: 'a1' })
  })

  it('says null asks for a host that predates them, and nothing for other frames', () => {
    expect(asksOf({ t: 'assistant.snapshot', agent: 'nova', snapshot: { messages: [] } })).toEqual({
      agent: 'nova',
      asks: null,
    })
    expect(asksOf({ t: 'reactions.snapshot', thread: 'assistant:nova' })).toBeNull()
    expect(asksOf({ t: 'assistant.snapshot', snapshot: {} })).toBeNull()
  })
})
