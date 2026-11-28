import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TicketBoardFacts } from '@relay/protocol'

vi.mock('../../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))
// SVAR paints its cell grid on a 2D canvas; jsdom has none.
const noop = (): void => {}
HTMLCanvasElement.prototype.getContext = (() => ({
  translate: noop,
  beginPath: noop,
  moveTo: noop,
  lineTo: noop,
  stroke: noop,
})) as unknown as HTMLCanvasElement['getContext']
HTMLCanvasElement.prototype.toDataURL = () => ''
// SVAR renders only the rows that fit its measured height; jsdom measures 0.
for (const [prop, px] of [
  ['clientHeight', 600],
  ['offsetHeight', 600],
  ['clientWidth', 1200],
  ['offsetWidth', 1200],
] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => px })
}
globalThis.ResizeObserver = class {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(target: Element): void {
    const entry = { target, contentRect: { width: 1200, height: 600 } }
    queueMicrotask(() => this.cb([entry as unknown as ResizeObserverEntry], this))
  }
  unobserve(): void {}
  disconnect(): void {}
}

import { TimelineView } from './TimelineView'

const T0 = Date.UTC(2026, 10, 20, 12)
const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

function ticket(key: string, over: Partial<TicketBoardFacts> = {}): TicketBoardFacts {
  return {
    key,
    id: `issue-${key}`,
    documentContentId: null,
    title: `Ticket ${key}`,
    url: '',
    state: { id: 's', name: 'Todo', type: 'unstarted', color: '#fff' },
    team: { id: 't', key: 'ENG' },
    priority: 2,
    prioritySortOrder: 0,
    assignee: null,
    creator: null,
    labels: [],
    project: { id: 'p1', name: 'Relay Board', targetDate: null },
    milestone: { id: 'm1', name: 'Board v1', targetDate: day(10), sortOrder: 1 },
    parent: null,
    children: [],
    relations: [],
    prs: [],
    dueDate: day(5),
    startedAt: null,
    createdAt: T0,
    updatedAt: T0,
    subscribed: true,
    prFacts: [],
    attention: { waiting: [], needsYou: null },
    ...over,
  }
}

describe('TimelineView (jsdom smoke)', () => {
  it('renders rows, the No date list, zoom keys and the re-plan gate', async () => {
    const onOpen = vi.fn()
    render(
      <MantineProvider>
        <TimelineView
          tickets={[ticket('ENG-1'), ticket('ENG-2', { dueDate: null, title: 'Someday' })]}
          onOpen={onOpen}
        />
      </MantineProvider>,
    )
    const view = screen.getByTestId('timeline')
    expect(view).toHaveAttribute('data-zoom', 'week')
    expect((await screen.findAllByText('Relay Board')).length).toBeGreaterThan(0)
    expect(document.querySelector('.wx-bar[data-id=":ENG-1"]')).not.toBeNull()
    expect(document.querySelector('[data-line="today"]')).not.toBeNull()
    expect(document.querySelector('[data-line="m:p1:m1"]')).not.toBeNull()
    expect(screen.getByTestId('timeline-nodate')).toHaveTextContent('ENG-2 Someday')
    await userEvent.click(screen.getByText('ENG-2 Someday'))
    expect(onOpen).toHaveBeenCalledWith('ENG-2')
    await userEvent.click(document.querySelector<HTMLElement>('.wx-bar[data-id=":ENG-1"]')!)
    expect(onOpen).toHaveBeenCalledWith('ENG-1')
    view.focus()
    await userEvent.keyboard('q')
    expect(view).toHaveAttribute('data-zoom', 'quarter')
    await userEvent.keyboard('=')
    expect(view).toHaveAttribute('data-zoom', 'month')
    // The bar click picked ENG-1's milestone as the re-plan scope.
    expect(screen.getByRole('button', { name: /Ask Astra to re-plan/ })).toBeEnabled()
    expect(screen.queryByTestId('plan-panel')).toBeNull()
  })

  it('read-only (no host sync): the chart without re-plan or a draft', async () => {
    render(
      <MantineProvider>
        <TimelineView tickets={[ticket('ENG-1')]} onOpen={vi.fn()} readOnly />
      </MantineProvider>,
    )
    expect((await screen.findAllByText('Relay Board')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Ask Astra to re-plan/ })).toBeNull()
    expect(screen.queryByTestId('plan-panel')).toBeNull()
  })
})
