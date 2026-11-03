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

describe('chat store with several panes', () => {
  beforeEach(() => chatStore.setState({ panes: {}, pendingExtras: {} }))

  const msg = (id: string, text: string) =>
    ({ id, role: 'assistant', text, streaming: true }) as never
  const extras = (paneId: string, running: boolean) => ({
    paneId,
    running,
    subagents: [],
    jobs: [],
  })

  it('keeps main and a tool pane on one thread apart, and drops only the tool pane', () => {
    const s = chatStore.getState()
    s.openPane('pane-1', { file: '/s/nova.jsonl', title: 'Nova', messages: [], meta })
    // A tool pane's extras can arrive before its open answers.
    s.setExtras(extras('tool-1', true))
    s.openPane('tool-1', { file: '/s/nova.jsonl', title: 'Nova', messages: [], meta })
    s.setExtras(extras('pane-1', false))
    s.applyOps('tool-1', [{ op: 'upsert', message: msg('m1', 'Foxes') }], 1)
    s.applyOps('tool-1', [{ op: 'meta', patch: { running: true } }], 2)
    const { panes } = chatStore.getState()
    expect(panes['tool-1']).toMatchObject({ lastSeq: 2, running: true, extras: { running: true } })
    expect(panes['tool-1']!.messages.map((m) => m.text)).toEqual(['Foxes'])
    expect(panes['pane-1']).toMatchObject({ lastSeq: 0, running: false, messages: [] })
    expect(panes['pane-1']!.extras.running).toBe(false)

    chatStore.getState().dropPane('tool-1')
    expect(Object.keys(chatStore.getState().panes)).toEqual(['pane-1'])
    // A late batch for the dropped pane lands nowhere.
    chatStore.getState().applyOps('tool-1', [{ op: 'meta', patch: { running: false } }], 3)
    expect(chatStore.getState().panes['tool-1']).toBeUndefined()
    expect(chatStore.getState().pendingExtras['tool-1']).toBeUndefined()
  })
})
