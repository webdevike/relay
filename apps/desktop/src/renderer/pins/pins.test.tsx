// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pin } from '@evaos/chat-core/pins'

const mocks = vi.hoisted(() => ({
  openLink: vi.fn(),
  invoke: vi.fn(async () => ({ ok: true, value: { opened: true } })),
  showPath: vi.fn(),
  revealTool: vi.fn(),
}))
vi.mock('../navigation/open-link', () => ({ openLink: mocks.openLink }))
vi.mock('../ipc', () => ({ invoke: mocks.invoke, on: vi.fn(() => () => undefined) }))
vi.mock('../files/files-store', () => ({ showPath: mocks.showPath }))
vi.mock('../tiling/tiling-store', () => ({ revealTool: mocks.revealTool }))
vi.mock('../assistants/AgentPortrait', () => ({
  AgentPortrait: () => <i data-testid="portrait" />,
}))
vi.mock('../assistants/assistants-store', () => ({
  useAssistants: (sel: (s: unknown) => unknown) => sel({}),
  agentOf: (_s: unknown, id: string) => (id === 'astra' ? { id, title: 'Astra' } : undefined),
}))

import { openTargetOf } from '../navigation/open-target'
import { PinsList, PinRow, COPIED_MS } from './PinsList'
import { PinsButton, PinsRail, RAIL_GAP, RAIL_EDGE, RAIL_W, railFits } from './PinsRail'
import { inlineTarget, selectionTarget, sourceOf } from './PinHoverLayer'
import type { PinsScopeValue } from './pins-scope'

const pin = (over: Partial<Pin> & Pick<Pin, 'id' | 'kind' | 'label' | 'value'>): Pin => ({
  pinnedBy: 'isaac',
  at: 1,
  ...over,
})

// jsdom has no layout: a selection's box is empty.
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
}

const PINS: Pin[] = [
  pin({
    id: 'p1',
    kind: 'link',
    label: 'Staging login',
    value: 'https://stg.example.com/login',
    source: 'assistant@5',
    pinnedBy: 'astra',
  }),
  pin({ id: 'p2', kind: 'code', label: 'Deploy', value: 'bun deploy' }),
  pin({ id: 'p3', kind: 'number', label: 'Order', value: '8841', source: 'user@3' }),
  pin({ id: 'p4', kind: 'file', label: 'Notes', value: '/Users/ike/Eva/notes.md' }),
  pin({ id: 'p5', kind: 'text', label: 'Reminder', value: 'call back' }),
]

function scopeOf(over: Partial<PinsScopeValue> = {}): PinsScopeValue {
  return {
    thread: 'assistant:astra',
    up: true,
    pins: PINS,
    file: '/s/chat.jsonl',
    pin: vi.fn(),
    unpin: vi.fn(),
    reveal: vi.fn(),
    ...over,
  }
}

const ui = (node: React.ReactNode) => render(<MantineProvider>{node}</MantineProvider>)
const clip = { writeText: vi.fn(async () => undefined) }

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true })
  clip.writeText.mockClear()
  Object.values(mocks).forEach((m) => m.mockClear())
})
afterEach(() => vi.useRealTimers())

describe('PinsRail', () => {
  it('lists each pin as a row: label, value, monospace for code and numbers only', () => {
    ui(<PinsRail scope={scopeOf()} />)
    const rail = screen.getByTestId('pins-rail')
    expect(within(rail).getByText('Pinned')).toBeTruthy()
    const rows = within(rail).getAllByTestId(/^pin-p\d$/)
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual([
      'link',
      'code',
      'number',
      'file',
      'text',
    ])
    const mono = (id: string) =>
      within(screen.getByTestId(`pin-${id}`))
        .getByTestId('pin-value')
        .getAttribute('data-mono')
    expect([mono('p1'), mono('p2'), mono('p3'), mono('p4'), mono('p5')]).toEqual([
      null,
      'true',
      'true',
      null,
      null,
    ])
    expect(within(screen.getByTestId('pin-p2')).getByTestId('pin-value').textContent).toBe(
      'bun deploy',
    )
  })

  it('shows nothing while there are no pins', () => {
    ui(<PinsRail scope={scopeOf({ pins: [] })} />)
    expect(screen.queryByTestId('pins-rail')).toBeNull()
  })

  it('names who pinned each: Isaac, an assistant by its name, or a chat', () => {
    ui(
      <PinsList
        scope={scopeOf({
          pins: [
            PINS[0]!,
            PINS[1]!,
            pin({ id: 'p9', kind: 'text', label: 'x', value: 'y', pinnedBy: 'chat 1f2e' }),
          ],
        })}
      />,
    )
    const names = screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual(['Pinned by Astra', 'Pinned by Isaac', 'Pinned by chat 1f2e'])
  })

  it('offers Open only for web links and file paths', () => {
    ui(<PinsList scope={scopeOf()} />)
    const has = (id: string) =>
      within(screen.getByTestId(`pin-${id}`)).queryByTestId('pin-open') !== null
    expect([has('p1'), has('p2'), has('p3'), has('p4'), has('p5')]).toEqual([
      true,
      false,
      false,
      true,
      false,
    ])
  })
})

describe('a pin row', () => {
  it('copies the value and shows a check for a moment', async () => {
    vi.useFakeTimers()
    ui(<PinsList scope={scopeOf()} />)
    const row = screen.getByTestId('pin-p2')
    await act(async () => {
      fireEvent.click(within(row).getByTestId('pin-copy'))
    })
    expect(clip.writeText).toHaveBeenCalledWith('bun deploy')
    expect(row.getAttribute('data-copied')).toBe('true')
    expect(within(row).getByTestId('pin-copy').getAttribute('aria-label')).toBe('Copied')
    await act(async () => {
      vi.advanceTimersByTime(COPIED_MS + 10)
    })
    expect(row.getAttribute('data-copied')).toBeNull()
    expect(within(row).getByTestId('pin-copy').getAttribute('aria-label')).toBe('Copy Deploy')
  })

  it('opens a link in the workspace on a click, with the click rules, and in Arc on Option+click', () => {
    ui(<PinsList scope={scopeOf()} />)
    const open = within(screen.getByTestId('pin-p1')).getByTestId('pin-open')
    fireEvent.click(open)
    expect(mocks.openLink).toHaveBeenCalledWith('https://stg.example.com/login', {
      target: openTargetOf({}),
    })
    fireEvent.click(open, { metaKey: true })
    expect(mocks.openLink).toHaveBeenLastCalledWith('https://stg.example.com/login', {
      target: openTargetOf({ metaKey: true }),
    })
    fireEvent.click(open, { altKey: true })
    expect(mocks.invoke).toHaveBeenCalledWith('artifacts.openExternal', {
      url: 'https://stg.example.com/login',
    })
    expect(mocks.openLink).toHaveBeenCalledTimes(2)
  })

  it('opens a file in the Files tab', () => {
    ui(<PinsList scope={scopeOf()} />)
    fireEvent.click(within(screen.getByTestId('pin-p4')).getByTestId('pin-open'))
    expect(mocks.revealTool).toHaveBeenCalledWith('files')
    expect(mocks.showPath).toHaveBeenCalledWith('/Users/ike/Eva/notes.md', '/s/chat.jsonl')
  })

  it('scrolls to the source message from the label, only when it has one', () => {
    const scope = scopeOf()
    ui(<PinsList scope={scope} />)
    fireEvent.click(within(screen.getByTestId('pin-p3')).getByTestId('pin-label'))
    expect(scope.reveal).toHaveBeenCalledWith('user@3')
    const plain = within(screen.getByTestId('pin-p2')).getByTestId('pin-label')
    expect(plain.tagName).toBe('SPAN')
    fireEvent.click(plain)
    expect(scope.reveal).toHaveBeenCalledTimes(1)
  })

  it('unpins from the x, which is off while Relay is down', () => {
    const scope = scopeOf()
    const { unmount } = ui(<PinRow pin={PINS[1]!} scope={scope} />)
    fireEvent.click(screen.getByTestId('pin-unpin'))
    expect(scope.unpin).toHaveBeenCalledWith('p2')
    unmount()
    const down = scopeOf({ up: false })
    ui(<PinRow pin={PINS[1]!} scope={down} />)
    expect((screen.getByTestId('pin-unpin') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the narrow layout', () => {
  it('fits the rail only when the gutter beside the column holds it', () => {
    const need = 780 + 2 * (RAIL_GAP + RAIL_W + RAIL_EDGE)
    expect(railFits(need, 780)).toBe(true)
    expect(railFits(need - 1, 780)).toBe(false)
    expect(railFits(1600, 780)).toBe(true)
    expect(railFits(900, 780)).toBe(false)
  })

  it('collapses to a pin count button that opens the same list', async () => {
    ui(<PinsButton scope={scopeOf()} />)
    const button = screen.getByTestId('pins-button')
    expect(button.getAttribute('aria-label')).toBe('Pinned, 5')
    expect(button.textContent).toBe('5')
    await act(async () => {
      fireEvent.click(button)
    })
    const pop = await screen.findByTestId('pins-popover')
    expect(within(pop).getAllByTestId(/^pin-p\d$/)).toHaveLength(5)
  })

  it('has no button while nothing is pinned', () => {
    ui(<PinsButton scope={scopeOf({ pins: [] })} />)
    expect(screen.queryByTestId('pins-button')).toBeNull()
  })
})

describe('what a hover or a selection would pin', () => {
  const bubble = (html: string): HTMLElement => {
    document.body.innerHTML = `<div data-pin-source="assistant@9"><div class="eva-md">${html}</div></div>`
    return document.body.querySelector<HTMLElement>('.eva-md')!
  }

  it('reads the bubble key of the message a node is in', () => {
    const md = bubble('<p>hi</p>')
    expect(sourceOf(md.querySelector('p'))).toBe('assistant@9')
    expect(sourceOf(null)).toBeUndefined()
  })

  it('pins a link by its text, a bare link by its host and path, ignoring non-web links', () => {
    const md = bubble(
      '<a href="https://github.com/o/r/pull/4">the PR</a> <a href="https://example.com/a/b">https://example.com/a/b</a> <a href="mention:blue">@Mara</a>',
    )
    const [pr, bare, mention] = Array.from(md.querySelectorAll('a'))
    expect(inlineTarget(pr!)?.note).toEqual({
      kind: 'pr',
      label: 'the PR',
      value: 'https://github.com/o/r/pull/4',
      source: 'assistant@9',
    })
    expect(inlineTarget(bare!)?.note).toMatchObject({ kind: 'link', label: 'example.com/a/b' })
    expect(inlineTarget(mention!)).toBeNull()
  })

  it('pins an inline code span as code, or as its own kind when it is a path or number, but not a fenced block', () => {
    const md = bubble(
      '<p><code>bun deploy</code> <code>/tmp/a.txt</code> <code>4242</code></p><pre><code>big block</code></pre>',
    )
    const codes = Array.from(md.querySelectorAll('code'))
    expect(inlineTarget(codes[0]!)?.note).toMatchObject({ kind: 'code', value: 'bun deploy' })
    expect(inlineTarget(codes[1]!)?.note).toMatchObject({ kind: 'file', value: '/tmp/a.txt' })
    expect(inlineTarget(codes[2]!)?.note).toMatchObject({ kind: 'number', value: '4242' })
    expect(inlineTarget(codes[3]!)).toBeNull()
  })

  it('pins the selected text of one message with its source, as code inside code', () => {
    const md = bubble('<p>The order is 8841 for Ana.</p><p><code>bun deploy --prod</code></p>')
    const text = md.querySelector('p')!.firstChild!
    const sel = window.getSelection()!
    const range = document.createRange()
    range.setStart(text, 13)
    range.setEnd(text, 17)
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectionTarget(sel)?.note).toEqual({
      kind: 'number',
      label: '8841',
      value: '8841',
      source: 'assistant@9',
    })
    const code = md.querySelector('code')!.firstChild!
    range.setStart(code, 0)
    range.setEnd(code, 'bun deploy'.length)
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectionTarget(sel)?.note).toMatchObject({ kind: 'code', value: 'bun deploy' })
    sel.removeAllRanges()
    expect(selectionTarget(sel)).toBeNull()
  })

  it('ignores a selection outside any message or spanning two', () => {
    document.body.innerHTML =
      '<p id="out">outside text</p><div data-pin-source="user@1">one</div><div data-pin-source="user@2">two</div>'
    const sel = window.getSelection()!
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('out')!)
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectionTarget(sel)).toBeNull()
    const a = document.querySelector('[data-pin-source="user@1"]')!.firstChild!
    const b = document.querySelector('[data-pin-source="user@2"]')!.firstChild!
    range.setStart(a, 0)
    range.setEnd(b, 3)
    sel.removeAllRanges()
    sel.addRange(range)
    expect(selectionTarget(sel)).toBeNull()
  })
})
