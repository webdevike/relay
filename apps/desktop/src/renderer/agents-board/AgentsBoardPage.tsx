import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Select, Switch, TextInput, Tooltip } from '@mantine/core'
import { IconLayoutKanban, IconSearch } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { AGENT_COLUMNS, type AgentCard, type AgentColumn } from '@evaos/contract'
import { ListEmpty } from '../ui/list'
import { AgentCardView, COLUMN_ICON } from './AgentCard'
import { AgentPanel, BOARD_MIN, PANEL_MIN } from './AgentPanel'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import {
  collapsePanel,
  selectCard,
  setBoardFilters,
  startAgentsBoard,
  useAgentsBoard,
} from './agents-store'
import {
  COLUMN_TITLE,
  byColumn,
  lanesOf,
  optionsOf,
  visibleCards,
  type GroupBy,
} from './board-view'
import './agents-board.css'

const GROUPS: Array<{ value: GroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' },
  { value: 'agent', label: 'Group by agent' },
  { value: 'workspace', label: 'Group by workspace' },
]

/** Re-renders every 30 s, so "5m ago" stays true between boards. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/** The page's width, followed as the window or the panes around it resize. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return width
}

function ColumnHead({ column, count }: { column: AgentColumn; count: number }) {
  const Glyph = COLUMN_ICON[column]
  return (
    <div className="eva-ab-colhead" data-column={column} data-testid={`agents-col-${column}`}>
      <Glyph size={16} stroke={1.75} className="eva-ab-colicon" aria-hidden />
      <span className="eva-ab-coltitle">{COLUMN_TITLE[column]}</span>
      <span className="eva-ab-count" data-testid={`agents-count-${column}`}>
        {count}
      </span>
    </div>
  )
}

function Lane({
  cards,
  selected,
  now,
}: {
  cards: readonly AgentCard[]
  selected: string | null
  now: number
}) {
  const cols = byColumn(cards)
  return (
    <div className="eva-ab-lane">
      {AGENT_COLUMNS.map((col) => (
        <div key={col} className="eva-ab-cell" data-column={col}>
          {cols[col].map((c) => (
            <AgentCardView
              key={c.id}
              card={c}
              now={now}
              active={c.id === selected}
              onOpen={() => selectCard(c.id)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function AgentsBoardPage(_props: { place: Place }) {
  useEffect(() => startAgentsBoard(), [])
  const board = useAgentsBoard((s) => s.board)
  const error = useAgentsBoard((s) => s.error)
  const selected = useAgentsBoard((s) => s.selected)
  const collapsed = useAgentsBoard((s) => s.collapsed)
  const filters = useAgentsBoard((s) => s.filters)
  const now = useNow()
  const page = useRef<HTMLDivElement>(null)
  const pageWidth = useWidth(page)
  const narrow = pageWidth > 0 && pageWidth < BOARD_MIN + PANEL_MIN

  const all = board?.cards ?? []
  const shown = visibleCards(all, filters)
  const staleCount = all.filter((c) => c.stale).length
  const counts = byColumn(shown)
  const lanes = lanesOf(shown, filters.group)
  const agents = optionsOf(all, 'agent')
  const workspaces = optionsOf(all, 'workspace')
  const card = selected === null ? null : (all.find((c) => c.id === selected) ?? null)
  const needs = counts.needs.length
  const working = counts.working.length
  // Esc closes the side panel (the drawer closes itself); a filter being cleared goes first.
  useDismissable(DISMISS_PRIORITY.selection, () => selectCard(null), card !== null && !narrow)

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && filters.query !== '') {
      e.stopPropagation()
      setBoardFilters({ query: '' })
    }
  }

  return (
    <div className="eva-ab" ref={page} data-testid="page-agents">
      <div className="eva-ab-main">
        <header className="eva-ab-head">
          <div className="eva-ab-heading">
            <h1 className="eva-ab-title" data-page-title>
              Agents
            </h1>
            {board ? (
              <span className="eva-ab-summary" data-testid="agents-summary">
                {[working > 0 ? `${working} working` : null, needs > 0 ? `${needs} need you` : null]
                  .filter(Boolean)
                  .join(', ') || 'Nothing running'}
              </span>
            ) : null}
          </div>
          <div className="eva-ab-filters">
            <TextInput
              size="xs"
              placeholder="Filter by key, title or session"
              leftSection={<IconSearch size={14} stroke={1.5} />}
              value={filters.query}
              onChange={(e) => setBoardFilters({ query: e.currentTarget.value })}
              onKeyDown={onSearchKey}
              aria-label="Filter cards"
              data-testid="agents-search"
              className="eva-ab-search"
            />
            <Select
              size="xs"
              data={[
                { value: '', label: 'All agents' },
                ...agents.map((a) => ({ value: a, label: a })),
              ]}
              value={filters.agent ?? ''}
              onChange={(v) => setBoardFilters({ agent: v ? v : null })}
              allowDeselect={false}
              aria-label="Agent"
              data-testid="agents-filter-agent"
              className="eva-ab-select"
            />
            <Select
              size="xs"
              data={[
                { value: '', label: 'All workspaces' },
                ...workspaces.map((w) => ({ value: w, label: w })),
              ]}
              value={filters.workspace ?? ''}
              onChange={(v) => setBoardFilters({ workspace: v ? v : null })}
              allowDeselect={false}
              aria-label="Workspace"
              data-testid="agents-filter-workspace"
              className="eva-ab-select"
            />
            <Select
              size="xs"
              data={GROUPS}
              value={filters.group}
              onChange={(v) =>
                setBoardFilters({ group: GROUPS.find((g) => g.value === v)?.value ?? 'none' })
              }
              allowDeselect={false}
              aria-label="Grouping"
              data-testid="agents-group"
              className="eva-ab-select"
            />
            <Tooltip
              label="Cards untouched for a week with nothing running on them"
              openDelay={300}
            >
              <Switch
                size="xs"
                label={`Stale (${staleCount})`}
                checked={filters.showStale}
                onChange={(e) => setBoardFilters({ showStale: e.currentTarget.checked })}
                data-testid="agents-stale"
                className="eva-ab-stale"
              />
            </Tooltip>
          </div>
        </header>

        {board === null ? (
          error ? (
            <ListEmpty role="alert" data-testid="agents-error" title="Could not read the board">
              {error}
            </ListEmpty>
          ) : (
            <div className="eva-ab-loading" data-testid="agents-loading">
              Reading tickets, sessions and helpers
            </div>
          )
        ) : all.length === 0 ? (
          <ListEmpty
            data-testid="agents-empty"
            icon={<IconLayoutKanban size={24} stroke={1.5} />}
            title="No agent work yet"
          >
            Work items, auto-work tickets and running helpers show up here as they start.
          </ListEmpty>
        ) : (
          <div className="eva-ab-board" data-testid="agents-board">
            <div className="eva-ab-cols">
              {AGENT_COLUMNS.map((col) => (
                <ColumnHead key={col} column={col} count={counts[col].length} />
              ))}
            </div>
            {lanes.map((lane) => (
              <section
                key={lane.id}
                className="eva-ab-group"
                data-testid={`agents-lane-${lane.id}`}
              >
                {lane.title ? (
                  <div className="eva-ab-lanehead">
                    <span className="eva-ab-lanetitle">{lane.title}</span>
                    <span className="eva-ab-count">{lane.cards.length}</span>
                  </div>
                ) : null}
                <Lane cards={lane.cards} selected={selected} now={now} />
              </section>
            ))}
          </div>
        )}
      </div>
      <AgentPanel
        card={card}
        now={now}
        narrow={narrow}
        pageWidth={pageWidth}
        collapsed={collapsed}
        onCollapse={collapsePanel}
        onClose={() => selectCard(null)}
      />
    </div>
  )
}
