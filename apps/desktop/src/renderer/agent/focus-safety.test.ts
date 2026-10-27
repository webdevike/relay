import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_FIXED_PAGES, type ChatRow } from '@evaos/contract'
import { pageFromKey } from '@evaos/shell-core'
import {
  decide,
  focusHeld,
  isEditable,
  isTyping,
  restoreTarget,
  withFocusHold,
} from './focus-safety'
import { findChat } from './actions'

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  document.body.append(e)
  return e
}

describe('isEditable', () => {
  it('counts text fields and contenteditable, not buttons or checkboxes', () => {
    expect(isEditable(el('textarea'))).toBe(true)
    expect(isEditable(el('input'))).toBe(true)
    expect(isEditable(el('input', { type: 'search' }))).toBe(true)
    expect(isEditable(el('input', { type: 'checkbox' }))).toBe(false)
    expect(isEditable(el('textarea', { readonly: '' }))).toBe(false)
    expect(isEditable(el('button'))).toBe(false)
    expect(isEditable(null)).toBe(false)
    const div = el('div')
    // jsdom has no isContentEditable; stand in for Chromium's.
    Object.defineProperty(div, 'isContentEditable', { value: true })
    expect(isEditable(div)).toBe(true)
  })
})

describe('decide', () => {
  const typing = { windowFocused: true, editable: true }
  it('queues main-column actions only while Isaac is typing in the focused window', () => {
    expect(isTyping(typing)).toBe(true)
    expect(decide('main', typing)).toBe('queue')
    expect(decide('none', typing)).toBe('run')
    expect(decide('main', { windowFocused: false, editable: true })).toBe('run')
    expect(decide('main', { windowFocused: true, editable: false })).toBe('run')
  })
})

describe('restoreTarget', () => {
  it('gives focus back to the text field the action took it from', () => {
    const composer = el('textarea')
    const editor = el('textarea')
    expect(restoreTarget(composer, editor)).toBe(composer)
    expect(restoreTarget(composer, composer)).toBeNull()
    expect(restoreTarget(el('button'), editor)).toBeNull()
    composer.remove()
    expect(restoreTarget(composer, editor)).toBeNull()
  })
})

describe('withFocusHold', () => {
  it('holds focus during the action and its tail, then restores the composer', async () => {
    vi.useFakeTimers()
    const composer = el('textarea')
    const other = el('input')
    composer.focus()
    let heldDuring = false
    const result = await withFocusHold(() => {
      heldDuring = focusHeld()
      other.focus()
      return 'ok'
    }, 100)
    expect(result).toBe('ok')
    expect(heldDuring).toBe(true)
    expect(focusHeld()).toBe(true)
    vi.advanceTimersByTime(100)
    expect(focusHeld()).toBe(false)
    expect(document.activeElement).toBe(composer)
  })

  it('releases the hold when the action throws', async () => {
    vi.useFakeTimers()
    const failing = withFocusHold(() => {
      throw new Error('x')
    }, 10)
    await expect(failing).rejects.toMatchObject({ message: 'x' })
    vi.advanceTimersByTime(10)
    expect(focusHeld()).toBe(false)
  })
})

describe('registry against the app', () => {
  it('lists only pages the app routes', () => {
    for (const p of AGENT_FIXED_PAGES) expect(pageFromKey(p)).toBe(p)
  })
})

describe('findChat', () => {
  const row = (id: string, title: string): ChatRow =>
    ({ id, file: `/s/${id}.jsonl`, title }) as unknown as ChatRow
  const rows = [row('a1', 'Fix login bug'), row('b2', 'Login page redesign'), row('c3', 'Taxes')]

  it('finds by id, file, exact title or every word', () => {
    expect(findChat(rows, 'b2').id).toBe('b2')
    expect(findChat(rows, '/s/c3.jsonl').id).toBe('c3')
    expect(findChat(rows, 'taxes').id).toBe('c3')
    expect(findChat(rows, 'login bug').id).toBe('a1')
  })

  it('fails on no match or several', () => {
    expect(() => findChat(rows, 'nothing here')).toThrow(/No chat/)
    expect(() => findChat(rows, 'login')).toThrow(/2 chats match/)
  })
})
