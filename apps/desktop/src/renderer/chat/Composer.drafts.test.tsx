import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'

/** Main's side of drafts.load / drafts.save, kept in memory as main's drafts.json would be. */
const mainDrafts = new Map<string, string>()
const sendResults: unknown[] = []
const invoke = vi.fn((channel: string, input?: unknown) => {
  if (channel === 'drafts.load') {
    const drafts = [...mainDrafts].map(([key, text]) => ({ key, text }))
    return Promise.resolve({ ok: true, value: { drafts } })
  }
  if (channel === 'drafts.save') {
    const { key, text } = input as { key: string; text: string }
    if (text === '') mainDrafts.delete(key)
    else mainDrafts.set(key, text)
    return Promise.resolve({ ok: true, value: {} })
  }
  if (channel === 'chat.send') {
    return Promise.resolve(sendResults.shift() ?? { ok: true, value: { accepted: true } })
  }
  return Promise.resolve({ ok: true, value: {} })
})
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
}))

import { Composer } from './Composer'
import { chatStore } from './chat-store'
import { draftsStore, loadDrafts, resetDraftsForTests } from './drafts'

const meta = { model: null, thinking: null, contextTokens: null }
const openPane = (file: string): void =>
  chatStore.getState().openPane('pane-1', { file, title: 't', messages: [], meta })

const ui = (draftKey: string | null) => (
  <MantineProvider>
    <Composer paneId="pane-1" disabled={false} draftKey={draftKey} />
  </MantineProvider>
)
const box = (): HTMLTextAreaElement => screen.getByTestId('composer-input')

beforeEach(() => {
  mainDrafts.clear()
  sendResults.length = 0
  invoke.mockClear()
  resetDraftsForTests()
  chatStore.setState({ panes: {} })
  openPane('/s/a.jsonl')
})

describe('Composer drafts', () => {
  it('restores the saved draft when its chat opens, without taking focus', async () => {
    mainDrafts.set('/s/a.jsonl', 'left over from before the restart')
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    render(ui('/s/a.jsonl'))
    await act(() => loadDrafts())
    expect(box()).toHaveValue('left over from before the restart')
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('saves each change through drafts.save and keeps drafts per chat', async () => {
    await loadDrafts()
    const user = userEvent.setup()
    const r = render(ui('/s/a.jsonl'))
    await user.type(box(), 'for a')
    expect(mainDrafts.get('/s/a.jsonl')).toBe('for a')
    r.rerender(ui('/s/b.jsonl'))
    expect(box()).toHaveValue('')
    await user.type(box(), 'for b')
    r.rerender(ui('/s/a.jsonl'))
    expect(box()).toHaveValue('for a')
    expect(Object.fromEntries(mainDrafts)).toEqual({ '/s/a.jsonl': 'for a', '/s/b.jsonl': 'for b' })
  })

  it('clears the saved draft when the message is sent', async () => {
    mainDrafts.set('/s/a.jsonl', 'ship it')
    await loadDrafts()
    const user = userEvent.setup()
    render(ui('/s/a.jsonl'))
    await user.type(box(), '{Enter}')
    expect(invoke).toHaveBeenCalledWith('chat.send', { paneId: 'pane-1', text: 'ship it' })
    expect(box()).toHaveValue('')
    await waitFor(() => expect(mainDrafts.has('/s/a.jsonl')).toBe(false))
    expect(draftsStore.getState().texts).toEqual({})
  })

  it('a failed send puts the draft back, saved again', async () => {
    sendResults.push({ ok: false, error: { code: 'spawn-failed', message: 'no omp' } })
    await loadDrafts()
    const user = userEvent.setup()
    render(ui('/s/a.jsonl'))
    await user.type(box(), 'keep me{Enter}')
    expect(box()).toHaveValue('keep me')
    await waitFor(() => expect(mainDrafts.get('/s/a.jsonl')).toBe('keep me'))
  })

  it("a new chat's draft follows it to the session file omp names", async () => {
    chatStore.setState({ panes: {} })
    openPane('')
    await loadDrafts()
    const user = userEvent.setup()
    const r = render(ui('draft:4'))
    await user.type(box(), 'still typing')
    expect(mainDrafts.get('draft:4')).toBe('still typing')
    act(() => {
      chatStore
        .getState()
        .applyOps('pane-1', [{ op: 'meta', patch: { sessionFile: '/s/new.jsonl' } }], 1)
    })
    r.rerender(ui('/s/new.jsonl'))
    expect(box()).toHaveValue('still typing')
    expect(Object.fromEntries(mainDrafts)).toEqual({ '/s/new.jsonl': 'still typing' })
  })

  it('keeps text typed before the saved drafts arrive', async () => {
    mainDrafts.set('/s/a.jsonl', 'older')
    const user = userEvent.setup()
    render(ui('/s/a.jsonl'))
    await user.type(box(), 'typed early')
    await act(() => loadDrafts())
    expect(box()).toHaveValue('typed early')
    expect(mainDrafts.get('/s/a.jsonl')).toBe('typed early')
  })

  it('a composer without a draft key saves nothing', async () => {
    await loadDrafts()
    const user = userEvent.setup()
    render(ui(null))
    await user.type(box(), 'scratch')
    expect(invoke.mock.calls.some((c) => c[0] === 'drafts.save')).toBe(false)
  })
})
