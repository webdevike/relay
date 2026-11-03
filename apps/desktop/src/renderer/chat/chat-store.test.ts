import { beforeEach, describe, expect, it } from 'vitest'
import { chatStore } from './chat-store'

const meta = { model: null, thinking: null, contextTokens: null }
const open = (file: string): void =>
  chatStore.getState().openPane('p', { file, title: 'New chat', messages: [], meta })
const pane = () => chatStore.getState().panes['p']!
const snap = (extra: Record<string, unknown> = {}) => ({
  seq: 3,
  messages: [],
  meta,
  running: false,
  connected: true,
  error: null,
  ...extra,
})

describe('chat store drafts and meta', () => {
  beforeEach(() => chatStore.setState({ panes: {} }))

  it('opens a draft with an empty file and no extras', () => {
    open('')
    expect(pane()).toMatchObject({
      file: '',
      title: 'New chat',
      dialog: null,
      contextWindow: null,
      thinking: null,
      boundTo: null,
    })
  })

  it('applies dialog, contextWindow and thinking patches', () => {
    open('/s/a.jsonl')
    const dialog = { kind: 'confirm', id: 'q', title: 'Sure?' } as never
    chatStore
      .getState()
      .applyOps(
        'p',
        [{ op: 'meta', patch: { dialog, contextWindow: 200000, thinking: 'high' } }],
        1,
      )
    expect(pane()).toMatchObject({ dialog, contextWindow: 200000, thinking: 'high' })
    chatStore.getState().applyOps('p', [{ op: 'meta', patch: { dialog: null } }], 2)
    expect(pane().dialog).toBeNull()
  })

  it('goal and handingOff follow meta patches and snapshots', () => {
    open('/s/a.jsonl')
    expect(pane()).toMatchObject({ goal: null, handingOff: false })
    const goal = { objective: 'ship it', paused: false, tokensUsed: 0 }
    chatStore.getState().applyOps('p', [{ op: 'meta', patch: { goal, handingOff: true } }], 1)
    expect(pane()).toMatchObject({ goal, handingOff: true })
    chatStore.getState().applySnapshot('p', snap({ handingOff: false }))
    expect(pane()).toMatchObject({ goal, handingOff: false })
    chatStore.getState().applySnapshot('p', snap({ goal: null }))
    expect(pane().goal).toBeNull()
  })

  it('a sessionFile patch binds a draft', () => {
    open('')
    chatStore.getState().applyOps('p', [{ op: 'meta', patch: { sessionFile: '/s/n.jsonl' } }], 1)
    expect(pane()).toMatchObject({ file: '/s/n.jsonl', boundTo: '/s/n.jsonl' })
  })

  it('a sessionFile patch never rebinds a pane that already has a file', () => {
    open('/s/a.jsonl')
    chatStore.getState().applyOps('p', [{ op: 'meta', patch: { sessionFile: '/s/n.jsonl' } }], 1)
    expect(pane()).toMatchObject({ file: '/s/a.jsonl', boundTo: null })
  })

  it('a snapshot carries the optional fields', () => {
    open('')
    chatStore.getState().applySnapshot('p', snap({ sessionFile: '/s/n.jsonl', dialog: null }))
    expect(pane()).toMatchObject({ file: '/s/n.jsonl', boundTo: '/s/n.jsonl', dialog: null })
  })

  it('a snapshot without the optional fields leaves them alone', () => {
    open('/s/a.jsonl')
    chatStore.getState().applySnapshot('p', snap())
    expect(pane()).toMatchObject({ file: '/s/a.jsonl', boundTo: null })
  })
})
