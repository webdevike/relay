import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ListEmpty,
  ListKpis,
  ListRow,
  ListMarks,
  ListView,
  type ListGroup,
  type ListViewProps,
} from '.'

interface Item {
  id: string
  name: string
  minutes: number
}

const item = (id: string, minutes = 10): Item => ({ id, name: `Item ${id}`, minutes })
const GROUPS: ListGroup<Item>[] = [
  { id: 'a', label: 'Alpha', items: [item('a1'), item('a2')], testid: 'group-a' },
  { id: 'b', label: 'Beta', items: [item('b1')], testid: 'group-b' },
]

function ui(props: Partial<ListViewProps<Item>> = {}, onOpen = vi.fn()) {
  const r = render(
    <MantineProvider>
      <div style={{ height: 400, overflowY: 'auto' }}>
        <ListView<Item>
          groups={GROUPS}
          rowKey={(i) => i.id}
          renderRow={(i) => (
            <ListRow
              key={i.id}
              data-testid={`row-${i.id}`}
              title={i.name}
              meta={`${i.minutes} min`}
              cells={[i.minutes, 'Photo']}
              onActivate={(e) => onOpen(i.id, e.type)}
            />
          )}
          data-testid="list"
          {...props}
        />
      </div>
    </MantineProvider>,
  )
  return { ...r, onOpen }
}

describe('ListView', () => {
  it('renders each group under a header with its count', () => {
    ui()
    expect(screen.getByTestId('group-a-label')).toHaveTextContent('Alpha')
    expect(screen.getByTestId('group-a-count')).toHaveTextContent('2')
    expect(within(screen.getByTestId('group-a')).getAllByRole('button')).toHaveLength(3)
    expect(screen.getByTestId('group-a-head')).toHaveAttribute('aria-expanded', 'true')
  })

  it('collapses and reopens a group, unmounting its rows', () => {
    ui()
    fireEvent.click(screen.getByTestId('group-a-head'))
    expect(screen.getByTestId('group-a-head')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('row-a1')).toBeNull()
    expect(screen.getByTestId('row-b1')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('group-a-head'))
    expect(screen.getByTestId('row-a1')).toBeInTheDocument()
  })

  it('starts collapsed from defaultCollapsed, and forceOpen overrides it', () => {
    const { rerender } = ui({ defaultCollapsed: ['b'] })
    expect(screen.queryByTestId('row-b1')).toBeNull()
    rerender(
      <MantineProvider>
        <ListView<Item>
          groups={GROUPS}
          rowKey={(i) => i.id}
          renderRow={(i) => <ListRow key={i.id} data-testid={`row-${i.id}`} title={i.name} />}
          defaultCollapsed={['b']}
          forceOpen
        />
      </MantineProvider>,
    )
    expect(screen.getByTestId('row-b1')).toBeInTheDocument()
  })

  it('reports toggles when controlled', () => {
    const onCollapsedChange = vi.fn()
    ui({ collapsed: new Set(['a']), onCollapsedChange })
    expect(screen.queryByTestId('row-a1')).toBeNull()
    fireEvent.click(screen.getByTestId('group-a-head'))
    expect(onCollapsedChange).toHaveBeenCalledWith('a', false)
    // Controlled: stays as the owner says until it changes the prop.
    expect(screen.queryByTestId('row-a1')).toBeNull()
  })

  it('moves focus with the arrow keys, Home and End, and opens with Enter or Space', () => {
    const { onOpen } = ui()
    const first = screen.getByTestId('row-a1')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByTestId('row-a2')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('row-a2'), { key: 'ArrowDown' })
    expect(screen.getByTestId('row-b1')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('row-b1'), { key: 'ArrowDown' })
    expect(screen.getByTestId('row-b1')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('row-b1'), { key: 'Home' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'End' })
    expect(screen.getByTestId('row-b1')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('row-b1'), { key: 'ArrowUp' })
    expect(screen.getByTestId('row-a2')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('row-a2'), { key: 'Enter' })
    fireEvent.keyDown(screen.getByTestId('row-a2'), { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenLastCalledWith('a2', 'keydown')
  })

  it('marks density on the list and its rows and headers', () => {
    ui({ density: 'compact' })
    expect(screen.getByTestId('list')).toHaveAttribute('data-density', 'compact')
    expect(screen.getByTestId('row-a1')).toHaveAttribute('data-density', 'compact')
    expect(screen.getByTestId('group-a-head').parentElement).toHaveAttribute(
      'data-density',
      'compact',
    )
    // Compact rows are one line: the meta stays inside the text run beside the title.
    expect(within(screen.getByTestId('row-a1')).getByText('10 min')).toBeInTheDocument()
  })

  it('lays rows on columns under a header row, first column left and the rest aligned', () => {
    ui({
      columns: [
        { id: 'name', label: 'Habit' },
        { id: 'minutes', label: 'Minutes', align: 'end' },
        { id: 'proof', label: 'Proof' },
      ],
    })
    const list = screen.getByTestId('list')
    expect(list).toHaveAttribute('data-columns', 'true')
    expect(list.style.getPropertyValue('--eva-list-grid')).toBe(
      'minmax(0, 2.4fr) minmax(0, 1fr) minmax(0, 1fr)',
    )
    expect(screen.getByText('Habit')).toHaveAttribute('data-align', 'start')
    expect(screen.getByText('Minutes')).toHaveAttribute('data-align', 'end')
    expect(screen.getByText('Proof')).toHaveAttribute('data-align', 'center')
    const row = screen.getByTestId('row-a1')
    expect(row).toHaveAttribute('data-grid', 'true')
    const cells = row.querySelectorAll('.eva-list-cell')
    expect(cells).toHaveLength(3)
    expect(cells[1]).toHaveTextContent('10')
    expect(cells[1]).toHaveAttribute('data-align', 'end')
    expect(cells[2]).toHaveTextContent('Photo')
  })

  it('shows loading, error and empty states', () => {
    const { unmount } = ui({ loading: { label: 'Loading items', testid: 'list-loading' } })
    expect(screen.getByTestId('list-loading')).toHaveAttribute('role', 'status')
    expect(screen.getByText('Loading items')).toBeInTheDocument()
    expect(screen.queryByTestId('row-a1')).toBeNull()
    unmount()

    const error = ui({
      error: <ListEmpty role="alert" title="Could not read items" data-testid="list-error" />,
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read items')
    error.unmount()

    ui({
      groups: [{ id: 'a', label: 'Alpha', items: [] }],
      empty: <ListEmpty title="No items yet" data-testid="list-empty" />,
    })
    expect(screen.getByTestId('list-empty')).toHaveTextContent('No items yet')
  })

  it("prefers a group's own empty line, and puts intro content above its rows", () => {
    ui({
      groups: [
        {
          id: 'a',
          label: 'Alpha',
          items: [],
          empty: 'Nothing here.',
          intro: <form aria-label="Add" />,
        },
      ],
      empty: <ListEmpty title="No items yet" />,
    })
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Add' })).toBeInTheDocument()
    expect(screen.queryByText('No items yet')).toBeNull()
  })

  it('renders the header slot, as KPIs', () => {
    ui({
      header: (
        <ListKpis
          items={[{ label: 'Habits', value: 4, pill: { tone: 'ok', label: 'On track' } }]}
        />
      ),
    })
    expect(screen.getByText('Habits')).toBeInTheDocument()
    expect(screen.getByText('On track')).toBeInTheDocument()
  })

  it('keeps KPIs beyond the shown ones in the info icon', () => {
    ui({
      header: (
        <ListKpis
          items={[{ label: 'Gate', value: 'Open' }]}
          more={[{ label: 'Streak', value: '3 days' }]}
        />
      ),
    })
    expect(screen.queryByText('Streak')).toBeNull()
    expect(screen.getByTestId('list-kpis-more')).toHaveAttribute('aria-label', 'Streak: 3 days')
  })

  it('draws statuses as fixed icon slots, an empty one keeping its place', () => {
    render(
      <MantineProvider>
        <ListMarks
          data-testid="m"
          slots={[
            { label: 'Draft', tone: 'dim', 'data-testid': 'draft' },
            null,
            { label: 'CI failing', tone: 'bad', 'data-testid': 'ci' },
          ]}
        />
      </MantineProvider>,
    )
    const slots = screen.getByTestId('m').children
    expect(slots).toHaveLength(3)
    expect(slots[1]).toBeEmptyDOMElement()
    expect(screen.getByTestId('draft')).toHaveTextContent('Draft')
    expect(screen.getByTestId('ci')).toHaveAttribute('data-tone', 'bad')
    expect(screen.getByTestId('ci')).toHaveTextContent('CI failing')
  })

  it('windows long lists', () => {
    const many = Array.from({ length: 400 }, (_, i) => item(`m${i}`))
    ui({ groups: [{ id: 'm', items: many }] })
    expect(screen.getByTestId('list')).toHaveAttribute('data-windowed', 'true')
    expect(document.querySelectorAll('[data-list-row]').length).toBeLessThan(400)
  })
})

describe('ListRow', () => {
  function row(props: Partial<Parameters<typeof ListRow>[0]> = {}) {
    return render(
      <MantineProvider>
        <ListRow data-testid="r" title="Nightly" {...props} />
      </MantineProvider>,
    )
  }

  it('has slots for leading, title, meta, trailing and hover actions', () => {
    const onActivate = vi.fn()
    const act1 = vi.fn()
    row({
      leading: <span data-testid="lead" />,
      meta: 'Every 2h',
      trailing: <span>ok</span>,
      actions: (
        <button type="button" onClick={act1}>
          Pin
        </button>
      ),
      onActivate,
    })
    const r = screen.getByTestId('r')
    expect(within(r).getByTestId('lead')).toBeInTheDocument()
    expect(within(r).getByText('Every 2h')).toBeInTheDocument()
    expect(within(r).getByText('ok')).toBeInTheDocument()
    fireEvent.click(within(r).getByText('Pin'))
    expect(act1).toHaveBeenCalled()
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.click(r)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('marks active and dim, and is static without a handler', () => {
    row({ active: true, dim: true })
    const r = screen.getByTestId('r')
    expect(r).toHaveAttribute('data-active', 'true')
    expect(r).toHaveAttribute('data-dim', 'true')
    expect(r).not.toHaveAttribute('role')
    expect(r).not.toHaveAttribute('tabindex')
  })

  it('opens on a middle click only when asked, and opens its menu on right click or Shift+F10', () => {
    vi.useFakeTimers()
    const onActivate = vi.fn()
    const onMenu = vi.fn()
    row({ onActivate, onMenu, middleClick: true })
    const r = screen.getByTestId('r')
    fireEvent(r, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(onActivate).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(r, { clientX: 5, clientY: 6 })
    expect(onMenu).toHaveBeenCalledWith(5, 6)
    fireEvent.keyDown(r, { key: 'F10', shiftKey: true })
    act(() => vi.runAllTimers())
    expect(onMenu).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
