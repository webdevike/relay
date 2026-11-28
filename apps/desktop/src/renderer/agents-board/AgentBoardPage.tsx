import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ActionIcon,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from '@mantine/core'
import { notifications, type NotificationData } from '@mantine/notifications'
import {
  DndContext,
  DragOverlay,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  IconAt,
  IconDots,
  IconEyeOff,
  IconLayoutKanban,
  IconRefresh,
  IconSearch,
} from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { AGENT_COLUMNS, type AgentBoard, type AgentCard, type AgentColumn } from '@evaos/contract'
import { ListEmpty } from '../ui/list'
import { EvaMenu, EvaModal } from '../overlay'
import { AgentCardView, CardFace, useCardSensors } from './AgentCard'
import { COLUMN_ICON } from './CardChips'
import { HiddenColumns, dropId } from './HiddenColumns'
import { openAgentLink } from './agent-link'
import { useCardMove, type CardMove } from './card-move-actor'
import { openPlace } from '../navigation/navigate'
import { cardPlace } from '../tickets/ticket-place'
import { parseOneOf, usePref } from '../ui-prefs'
import { BoardTimeline } from './BoardTimeline'
import {
  hideColumn,
  selectCard,
  setBoardFilters,
  startAgentsBoard,
  syncTickets,
  useAgentsBoard,
} from './agents-store'
import {
  COLUMN_TITLE,
  byColumn,
  freshnessLabel,
  visibleCards,
  waitingCount,
  type TicketsSource,
} from './board-view'
import './agents-board.css'

/** Re-renders every 30 s, so "5m ago" stays true between boards. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/**
 * A card opens its own target (a helper's chat, a harness pane) or, for a ticket or work item, its
 * page; the board marks it as the one last opened.
 */
function openCard(card: AgentCard): void {
  if (card.openTarget.kind === 'link') return openAgentLink(card.openTarget.open, 'here')
  const place = cardPlace(card)
  if (place === null) return
  selectCard(card.id)
  openPlace(place)
}

/** Where the board was scrolled when it was left (to a ticket's page), so coming back keeps it. */
let boardScroll: { left: number; cols: Record<string, number> } | null = null

function saveBoardScroll(el: HTMLElement): void {
  const cols: Record<string, number> = {}
  for (const col of el.querySelectorAll<HTMLElement>('section[data-column]')) {
    const cards = col.querySelector<HTMLElement>('.eva-ab-cards')
    if (cards && col.dataset.column) cols[col.dataset.column] = cards.scrollTop
  }
  boardScroll = { left: el.scrollLeft, cols }
}

function restoreBoardScroll(el: HTMLElement): void {
  if (boardScroll === null) return
  el.scrollLeft = boardScroll.left
  for (const [column, top] of Object.entries(boardScroll.cols)) {
    const cards = el.querySelector<HTMLElement>(`section[data-column="${column}"] .eva-ab-cards`)
    if (cards) cards.scrollTop = top
  }
}

/**
 * The board's scroll survives leaving the page: kept as it scrolls (the page may be hidden before
 * it unmounts, which reads as 0), put back as it mounts and again for a moment after, while the
 * pane it lands in is still taking its width. A timer, not frames: a hidden window has none.
 */
function useBoardScroll() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const target = boardScroll
    const sticks = (): boolean => target === null || el.scrollLeft === target.left
    let tries = 0
    restoreBoardScroll(el)
    let pending = !sticks()
    const timer = window.setInterval(() => {
      restoreBoardScroll(el)
      pending = !sticks() && ++tries < 6
      if (!pending) window.clearInterval(timer)
    }, 50)
    // Every real position is kept; one clamped while the pane still takes its width is not.
    const onScroll = (): void => {
      if (pending && !sticks()) return
      pending = false
      window.clearInterval(timer)
      saveBoardScroll(el)
    }
    el.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      window.clearInterval(timer)
      el.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [])
  return ref
}

function ColumnHead({ column, count }: { column: AgentColumn; count: number }) {
  const [menu, setMenu] = useState(false)
  const Glyph = COLUMN_ICON[column]
  return (
    <div className="eva-ab-colhead" data-column={column} data-testid={`agents-col-${column}`}>
      <Glyph size={16} stroke={1.75} className="eva-ab-colicon" aria-hidden />
      <span className="eva-ab-colname">{COLUMN_TITLE[column]}</span>
      <span className="eva-ab-count" data-testid={`agents-count-${column}`}>
        {count}
      </span>
      <span className="eva-ab-spacer" />
      <EvaMenu opened={menu} onChange={setMenu} position="bottom-end" width={180}>
        <EvaMenu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            size={24}
            className="eva-ab-colmenu"
            data-open={menu || undefined}
            aria-label={`${COLUMN_TITLE[column]} column menu`}
            data-testid={`agents-colmenu-${column}`}
          >
            <IconDots size={15} stroke={1.5} />
          </ActionIcon>
        </EvaMenu.Target>
        <EvaMenu.Dropdown>
          <EvaMenu.Item
            leftSection={<IconEyeOff size={15} stroke={1.5} />}
            onClick={() => hideColumn(column)}
            data-testid={`agents-hide-${column}`}
          >
            Hide column
          </EvaMenu.Item>
        </EvaMenu.Dropdown>
      </EvaMenu>
    </div>
  )
}

function Column({
  column,
  cards,
  selected,
  now,
}: {
  column: AgentColumn
  cards: readonly AgentCard[]
  selected: string | null
  now: number
}) {
  const drop = useDroppable({ id: dropId(column), data: { column } })
  return (
    <section
      ref={drop.setNodeRef}
      className="eva-ab-col"
      data-column={column}
      data-over={drop.isOver || undefined}
      aria-label={COLUMN_TITLE[column]}
    >
      <ColumnHead column={column} count={cards.length} />
      <div className="eva-ab-cards">
        {cards.map((c) => (
          <AgentCardView
            key={c.id}
            card={c}
            now={now}
            active={c.id === selected}
            onOpen={() => openCard(c)}
          />
        ))}
      </div>
    </section>
  )
}

/** Freshness of the synced tickets, and Refresh (asks the host to sync; rests 30 s after). */
function Freshness({ tickets, now }: { tickets: TicketsSource; now: number }) {
  const resting = useAgentsBoard((s) => s.syncRestUntil > 0)
  const host = tickets.source === 'host'
  const why = host
    ? tickets.syncAs
      ? `Syncing as ${tickets.syncAs}`
      : 'Synced from the Relay host'
    : 'Moving cards and Waiting on you need Linear sync on the host'
  const refresh = async (): Promise<void> => {
    const error = await syncTickets()
    if (error !== null) notifications.show({ color: 'red', message: `Couldn't sync: ${error}` })
  }
  return (
    <span className="eva-ab-fresh">
      <Tooltip label={why} openDelay={300} multiline maw={320}>
        <span className="eva-ab-freshtext" data-testid="agents-freshness">
          {freshnessLabel(tickets, now)}
        </span>
      </Tooltip>
      {host ? (
        <Tooltip label={resting ? 'Synced a moment ago' : 'Sync with Linear and GitHub now'}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size={24}
            aria-label="Refresh"
            disabled={resting}
            onClick={() => void refresh()}
            data-testid="agents-refresh"
          >
            <IconRefresh size={14} stroke={1.75} />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </span>
  )
}

function BoardBar({ board, shown, now }: { board: AgentBoard; shown: number; now: number }) {
  const filters = useAgentsBoard((s) => s.filters)
  const waiting = waitingCount(board.cards)
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape' && filters.query !== '') {
      e.stopPropagation()
      setBoardFilters({ query: '' })
    }
  }
  return (
    <div className="eva-ab-bar">
      <span className="eva-ab-items" data-testid="agents-summary">
        {shown === 1 ? '1 item' : `${shown} items`}
      </span>
      <UnstyledButton
        className="eva-ab-waittog"
        aria-pressed={filters.waitingOnly}
        data-on={filters.waitingOnly || undefined}
        onClick={() => setBoardFilters({ waitingOnly: !filters.waitingOnly })}
        data-testid="agents-waiting"
      >
        <IconAt size={13} stroke={2} aria-hidden />
        Waiting on you
        <span className="eva-ab-waitn" data-testid="agents-waiting-count">
          {waiting}
        </span>
      </UnstyledButton>
      <Freshness tickets={board.sources.tickets} now={now} />
      <span className="eva-ab-spacer" />
      <TextInput
        size="xs"
        placeholder="Search"
        leftSection={<IconSearch size={14} stroke={1.5} />}
        value={filters.query}
        onChange={(e) => setBoardFilters({ query: e.currentTarget.value })}
        onKeyDown={onSearchKey}
        aria-label="Search cards by key, title, session or agent"
        data-testid="agents-search"
        className="eva-ab-search"
      />
    </div>
  )
}

const MOVE_TOAST = 'agents-move'

function toastAction(label: string, run: () => void) {
  return (
    <Button
      variant="subtle"
      size="compact-sm"
      data-testid={`agents-move-${label.toLowerCase()}`}
      onClick={() => {
        notifications.hide(MOVE_TOAST)
        run()
      }}
    >
      {label}
    </Button>
  )
}

/** The toast a move's outcome shows: Undo on a settled move, Retry on a failed one. */
function moveToast(move: CardMove, key: (id: string) => string): NotificationData | null {
  const view = move.view
  switch (view.kind) {
    case 'staysPut':
      return { color: 'yellow', message: view.message }
    case 'conflict':
      return { color: 'red', message: view.message }
    case 'failed':
      return {
        color: 'red',
        autoClose: false,
        message: (
          <span className="eva-ab-toast">
            <span>{view.message}</span>
            {toastAction('Retry', move.retry)}
          </span>
        ),
      }
    case 'unknown':
      return { loading: true, autoClose: false, message: 'Checking whether it moved' }
    case 'settled':
      return {
        autoClose: 8000,
        message: (
          <span className="eva-ab-toast">
            <span>
              Moved {key(view.cardId)} to {COLUMN_TITLE[view.to]}
            </span>
            {view.canUndo ? toastAction('Undo', move.undo) : null}
          </span>
        ),
      }
    default:
      return null
  }
}

/**
 * One toast per move outcome. A refused or conflicting move is dismissed once it's said (its
 * column already rolled back); a settled move's Undo window closing doesn't toast again.
 */
function useMoveToasts(move: CardMove, keyOf: (id: string) => string): void {
  const latest = useRef({ move, keyOf })
  latest.current = { move, keyOf }
  const said = useRef('')
  const { view } = move
  useEffect(() => {
    const { move: m, keyOf: key } = latest.current
    const sig = 'cardId' in view ? `${view.kind}:${view.cardId}` : view.kind
    if (sig === said.current) return
    said.current = sig
    const toast = moveToast(m, key)
    if (toast === null) return
    notifications.hide(MOVE_TOAST)
    notifications.show({ id: MOVE_TOAST, ...toast })
    if (view.kind === 'staysPut' || view.kind === 'conflict') m.cancel()
  }, [view])
}

/** A Done or Canceled move asks first; an ambiguous column asks which status. */
function MoveDialogs({ move, cards }: { move: CardMove; cards: readonly AgentCard[] }) {
  const { view } = move
  const keyOf = (id: string): string => {
    const c = cards.find((x) => x.id === id)
    return c?.key ?? c?.title ?? 'the card'
  }
  useMoveToasts(move, keyOf)
  const confirming = view.kind === 'confirming' ? view : null
  const picking = view.kind === 'pickState' ? view : null
  return (
    <>
      <EvaModal
        opened={confirming !== null}
        onClose={move.cancel}
        title={confirming ? `Move ${keyOf(confirming.cardId)} to ${confirming.stateName}?` : ''}
        testid="agents-move-confirm"
      >
        <Stack gap="md">
          <Text size="sm">This changes its status in Linear.</Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={move.cancel}>
              Cancel
            </Button>
            <Button onClick={move.confirm} data-testid="agents-move-confirm-ok">
              Move
            </Button>
          </Group>
        </Stack>
      </EvaModal>
      <EvaModal
        opened={picking !== null}
        onClose={move.cancel}
        title={picking ? `Which status for ${keyOf(picking.cardId)}?` : ''}
        testid="agents-move-pick"
      >
        <Stack gap="xs">
          {picking?.options.map((o) => (
            <Button
              key={o.id}
              variant="default"
              justify="flex-start"
              onClick={() => move.pick(o.id)}
            >
              {o.name}
            </Button>
          ))}
        </Stack>
      </EvaModal>
    </>
  )
}

function Board({
  cards,
  selected,
  now,
  move,
}: {
  cards: readonly AgentCard[]
  selected: string | null
  now: number
  move: CardMove
}) {
  const hidden = useAgentsBoard((s) => s.hidden)
  const scroll = useBoardScroll()
  const [dragging, setDragging] = useState<AgentCard | null>(null)
  const sensors = useCardSensors()
  const cols = byColumn(cards, move.columnOf)
  const onDragStart = ({ active }: DragStartEvent): void => {
    setDragging((active.data.current as { card: AgentCard } | undefined)?.card ?? null)
  }
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    setDragging(null)
    const card = (active.data.current as { card: AgentCard } | undefined)?.card
    const to = (over?.data.current as { column: AgentColumn } | undefined)?.column
    if (!card || !to || to === (move.columnOf(card.id) ?? card.column)) return
    move.drop(card, to)
  }
  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(null)
      }}
    >
      <div className="eva-ab-board" ref={scroll} data-testid="agents-board">
        {AGENT_COLUMNS.filter((c) => !hidden.includes(c)).map((col) => (
          <Column key={col} column={col} cards={cols[col]} selected={selected} now={now} />
        ))}
        <HiddenColumns columns={hidden} cards={cols} onOpen={openCard} />
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="eva-ab-card" data-overlay>
            <CardFace card={dragging} now={now} onOpen={() => undefined} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

type BoardView = 'board' | 'timeline'
const VIEW_PREF = 'agents.view'
const parseView = parseOneOf<BoardView>(['board', 'timeline'])

/** Title and the view switch (`agents.view`, kept in layout.json). */
function PageHead({ view, onView }: { view: BoardView; onView(view: BoardView): void }) {
  return (
    <header className="eva-ab-head">
      <h1 className="eva-ab-title" data-page-title>
        Board
      </h1>
      <SegmentedControl
        size="xs"
        value={view}
        onChange={(v) => onView(v as BoardView)}
        className="eva-ab-viewsw"
        aria-label="View"
        data-testid="agents-view"
        data={[
          { value: 'board', label: <span data-testid="agents-view-board">Board</span> },
          { value: 'timeline', label: <span data-testid="agents-view-timeline">Timeline</span> },
        ]}
      />
    </header>
  )
}

/** No board yet (reading, or main couldn't), or a board with nothing on it. */
function NoCards({ board, error }: { board: AgentBoard | null; error: string | null }) {
  if (board !== null)
    return (
      <ListEmpty
        data-testid="agents-empty"
        icon={<IconLayoutKanban size={24} stroke={1.5} />}
        title="Nothing on the board yet"
      >
        Your Linear tickets, work items and running helpers show up here.
      </ListEmpty>
    )
  if (error)
    return (
      <ListEmpty role="alert" data-testid="agents-error" title="Could not read the board">
        {error}
      </ListEmpty>
    )
  return (
    <div className="eva-ab-loading" data-testid="agents-loading">
      Reading tickets, sessions and helpers
    </div>
  )
}

/** The columns view: toolbar, then the columns or why there are none. */
function BoardContent({ move }: { move: CardMove }) {
  const board = useAgentsBoard((s) => s.board)
  const error = useAgentsBoard((s) => s.error)
  const selected = useAgentsBoard((s) => s.selected)
  const filters = useAgentsBoard((s) => s.filters)
  const now = useNow()
  const all = board?.cards ?? []
  const shown = visibleCards(all, filters)
  return (
    <>
      {board ? <BoardBar board={board} shown={shown.length} now={now} /> : null}
      {board && all.length > 0 ? (
        <Board cards={shown} selected={selected} now={now} move={move} />
      ) : (
        <NoCards board={board} error={error} />
      )}
    </>
  )
}

/**
 * The Board page: everything the agents work on and Isaac's synced Linear tickets, as Linear's
 * board. A ticket or work item opens its page (`ticket:`); a run opens its own target. Dragging a
 * ticket to another column moves it in Linear (through the host's write gate). The Timeline view
 * plans the same synced tickets by date.
 */
export function AgentBoardPage(_props: { place: Place }) {
  useEffect(() => startAgentsBoard(), [])
  const cards = useAgentsBoard((s) => s.board?.cards)
  const move = useCardMove()
  const [view, setView] = usePref<BoardView>(VIEW_PREF, 'board', parseView)

  return (
    <div className="eva-ab" data-testid="page-board">
      <div className="eva-ab-main">
        <PageHead view={view} onView={setView} />
        {view === 'timeline' ? <BoardTimeline /> : <BoardContent move={move} />}
      </div>
      <MoveDialogs move={move} cards={cards ?? []} />
    </div>
  )
}
