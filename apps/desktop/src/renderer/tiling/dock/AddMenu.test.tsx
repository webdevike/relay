import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { IDockviewHeaderActionsProps } from 'dockview-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  splitAt: vi.fn(),
  zoomPane: vi.fn(),
  newChatTabIn: vi.fn(),
  openTab: vi.fn(),
  openPlaceInPane: vi.fn(),
  focusPaneById: vi.fn(),
  closePaneById: vi.fn(),
  openWebPage: vi.fn(async () => ({ pane: 'p1', tab: 'web:1', tabId: '1' })),
  newBoard: vi.fn(async () => {}),
  state: {
    zoom: null as string | null,
    lead: 'p1',
    panes: [
      { id: 'p1', app: true, views: ['tab:1'], active: 'tab:1', rect: null },
      { id: 'p2', app: false, views: ['files'], active: 'files', rect: null },
    ],
  },
}))

vi.mock('../../ipc', () => ({
  invoke: vi.fn(async () => ({ ok: true, value: {} })),
  on: () => () => {},
}))
vi.mock('../../shell/layout-store', () => ({ useLayout: () => 'open' }))
vi.mock('../web-tabs', () => ({
  openWebPage: m.openWebPage,
  webTabOf: (id: string | null) => (id?.startsWith('web:') ? id.slice('web:'.length) : null),
}))
vi.mock('../tiling-store', () => ({
  splitAt: m.splitAt,
  zoomPane: m.zoomPane,
  newChatTabIn: m.newChatTabIn,
  openTab: m.openTab,
  openPlaceInPane: m.openPlaceInPane,
  focusPaneById: m.focusPaneById,
  closePaneById: m.closePaneById,
  useTiling: <T,>(sel: (s: typeof m.state) => T) => sel(m.state),
}))
vi.mock('../../canvas/canvas-store', () => ({
  newBoard: m.newBoard,
  useCanvasListSurface: () => {},
  useCanvasList: <T,>(sel: (s: { entries: unknown[] }) => T) =>
    sel({ entries: [{ slug: 'moods', title: 'Moods' }] }),
}))

import { LeftActions, RightActions } from './HeaderActions'
import { TOOLS } from '../tools'

const props = (id: string) => ({ group: { id } }) as unknown as IDockviewHeaderActionsProps
const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

async function open(pane = 'p2', testid = `pane-add-${pane}`) {
  wrap(
    <>
      <LeftActions {...props(pane)} />
      <RightActions {...props(pane)} />
    </>,
  )
  fireEvent.click(screen.getByTestId(testid))
  return screen.findByTestId(`pane-add-menu-${pane}`)
}

describe('pane + menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    m.state.zoom = null
  })

  it('renders exactly one + per pane', async () => {
    wrap(
      <>
        {m.state.panes.map((p) => (
          <div key={p.id} data-testid={`strip-${p.id}`}>
            <LeftActions {...props(p.id)} />
            <RightActions {...props(p.id)} />
          </div>
        ))}
      </>,
    )
    for (const p of m.state.panes) {
      expect(
        within(screen.getByTestId(`strip-${p.id}`)).getAllByLabelText('Add a tab or split'),
      ).toHaveLength(1)
    }
  })

  it('a pane of pages opens a new page in one click and keeps the menu behind a chevron', async () => {
    m.state.panes.push({ id: 'p3', app: false, views: ['web:t4'], active: 'web:t4', rect: null })
    try {
      wrap(<LeftActions {...props('p3')} />)
      fireEvent.click(screen.getByTestId('page-new-tab-p3'))
      expect(m.openWebPage).toHaveBeenCalledWith({ pane: 'p3' })
      fireEvent.click(screen.getByTestId('pane-add-p3'))
      expect(await screen.findByTestId('pane-add-menu-p3')).toBeTruthy()
    } finally {
      m.state.panes.pop()
    }
  })

  it('lists TOOLS in order, then split, maximize and (app panes) new chat', async () => {
    const menu = await open('p1', 'tab-new')
    const rows = [...menu.querySelectorAll('[role=menuitem]')].map((e) =>
      e.getAttribute('data-testid'),
    )
    expect(rows).toEqual([
      ...TOOLS.map((t) => `pane-add-tool-${t.id}-p1`),
      'pane-add-split-right-p1',
      'pane-add-split-down-p1',
      'pane-add-zoom-p1',
      'pane-add-new-chat-p1',
    ])
    expect([...menu.querySelectorAll('[role=menuitem]')][0].textContent).toContain('Browser page')
  })

  it('arrow keys and Enter pick an item', async () => {
    const menu = await open()
    fireEvent.keyDown(menu.querySelector('[role=menu]')!, { key: 'ArrowDown' })
    fireEvent.keyDown(menu.querySelector('[role=menu]')!, { key: 'Enter' })
    expect(m.openTab).toHaveBeenCalledWith({ kind: 'files' }, 'p2')
  })

  it('Enter on the first item opens a browser page in the pane', async () => {
    const menu = await open()
    fireEvent.keyDown(menu.querySelector('[role=menu]')!, { key: 'Enter' })
    expect(m.openWebPage).toHaveBeenCalledWith({ pane: 'p2' })
  })

  it('typing filters the list and shows the filter field', async () => {
    const menu = await open()
    fireEvent.keyDown(menu.querySelector('[role=menu]')!, { key: 't' })
    expect(screen.getByTestId('pane-add-filter-p2')).toBeTruthy()
    fireEvent.change(screen.getByTestId('pane-add-filter-p2'), { target: { value: 'term' } })
    const rows = [...menu.querySelectorAll('[role=menuitem]')]
    expect(rows).toHaveLength(1)
    fireEvent.keyDown(menu.querySelector('[role=menu]')!, { key: 'Enter' })
    expect(m.openTab).toHaveBeenCalledWith({ kind: 'terminal' }, 'p2')
  })

  it('split and maximize items call the tiling store', async () => {
    fireEvent.click(within(await open()).getByTestId('pane-add-split-right-p2'))
    expect(m.splitAt).toHaveBeenCalledWith('p2', 'right')
    fireEvent.click(screen.getByTestId('pane-add-p2'))
    fireEvent.click(await screen.findByTestId('pane-add-split-down-p2'))
    expect(m.splitAt).toHaveBeenCalledWith('p2', 'down')
    fireEvent.click(screen.getByTestId('pane-add-p2'))
    fireEvent.click(await screen.findByTestId('pane-add-zoom-p2'))
    expect(m.zoomPane).toHaveBeenCalledWith('p2', true)
  })

  it('new chat only in app panes', async () => {
    expect(within(await open()).queryByTestId('pane-add-new-chat-p2')).toBeNull()
  })

  it('Canvas opens a board step with New board first', async () => {
    const menu = await open()
    fireEvent.click(within(menu).getByTestId('pane-add-tool-canvas-p2'))
    const rows = [...menu.querySelectorAll('[role=menuitem]')].map((e) => e.textContent)
    expect(rows).toEqual(['New board', 'Moods'])
    fireEvent.click(within(menu).getByTestId('pane-add-canvas-moods-p2'))
    expect(m.openPlaceInPane).toHaveBeenCalledWith(
      expect.objectContaining({ page: 'canvas', canvas: 'moods' }),
      'p2',
    )
  })

  it('Escape closes', async () => {
    const menu = await open()
    fireEvent.keyDown(menu.querySelector('[role=menu]')!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  })
})
