// One ticket as its own page (`ticket:ENG-12`, `ticket:item/<id>`, `ticket:ENG-12/pr/o/r/7`), after
// Linear's issue view: a top bar (Board > column > key, prev/next over the board's order), a
// centered main column (title, summary, description, sub-issues, resources, activity) beside the
// properties sidebar, or, with the sidebar folded, a one-line status strip. A PR's page shows the
// Reviews detail for it inside the same chrome. Esc goes PR, ticket, board through the window's
// history, so the board comes back as it was left.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ActionIcon, Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconCircleCheckFilled,
  IconExternalLink,
  IconLayoutKanban,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
} from '@tabler/icons-react'
import type { AgentCard, ReviewPr, ReviewPrHit } from '@evaos/contract'
import { placeKey, placeOf, type Place } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { setReviewTitle } from '../eva/names-store'
import { openLink } from '../navigation/open-link'
import { openPlace } from '../navigation/navigate'
import { historyJump, navHistoryStore } from '../navigation/nav-history'
import { useReplacePlace } from '../pages/place-host'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { Detail } from '../reviews/ReviewsPage'
import { startAgentsBoard, useAgentsBoard } from '../agents-board/agents-store'
import { COLUMN_TITLE, visibleCards } from '../agents-board/board-view'
import type { TicketPr } from '../agents-board/ticket-prs'
import { SummaryCard } from './SummaryCard'
import { Activity, TicketDescription } from './Activity'
import { Resources } from './Resources'
import { StatusStrip } from './StatusStrip'
import { TicketSidebar } from './TicketSidebar'
import {
  pagePrs,
  setSidebarOpen,
  useTicketData,
  useTicketsUi,
  type TicketData,
} from './ticket-data'
import {
  boardOrder,
  cardOfRef,
  cardPlace,
  parseTicketPlace,
  ticketHome,
  ticketPlace,
  type TicketPrRef,
  type TicketRef,
} from './ticket-place'
import './tickets.css'

/** Re-renders every 30 s, so "5m ago" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

/**
 * Back to `target` through the window's history: the nearest earlier entry in this tab showing it
 * (so the board comes back with its scroll), else this tab is pointed there.
 */
function backTo(target: Place, replace: (p: Place) => void): void {
  const h = navHistoryStore.getState()
  const here = h.entries[h.index]
  const want = placeKey(target)
  for (let i = h.index - 1; i >= 0; i--) {
    const e = h.entries[i]!
    if (here && e.tab !== here.tab) continue
    if (placeKey(e.place) === want) return historyJump(i)
  }
  replace(target)
}

/** One `reviews.prSearch` per page open (title and branch hits name more PRs). */
function usePrHits(key: string | null): ReviewPrHit[] {
  const [hits, setHits] = useState<ReviewPrHit[]>([])
  useEffect(() => {
    if (key === null) return
    let live = true
    void invoke('reviews.prSearch', { key }).then((r) => {
      if (live && r.ok) setHits(r.value)
    })
    return () => {
      live = false
    }
  }, [key])
  return hits
}

/** The board's cards in reading order, for prev/next. */
function useBoardOrder(): AgentCard[] {
  const board = useAgentsBoard((s) => s.board)
  const filters = useAgentsBoard((s) => s.filters)
  const hidden = useAgentsBoard((s) => s.hidden)
  return useMemo(
    () => boardOrder(visibleCards(board?.cards ?? [], filters), hidden),
    [board, filters, hidden],
  )
}

function Crumbs({
  at,
  card,
  title,
  go,
  leave,
}: {
  at: TicketRef
  card: AgentCard | null
  title: string
  go: (p: Place) => void
  leave: () => void
}) {
  const key = at.kind === 'key' ? at.id : (card?.key ?? at.id)
  return (
    <nav className="eva-tk-crumbs" aria-label="Breadcrumb" data-testid="ticket-crumbs">
      <UnstyledButton className="eva-tk-crumb" onClick={leave} data-testid="ticket-crumb-board">
        <IconLayoutKanban size={14} stroke={1.5} aria-hidden />
        Board
      </UnstyledButton>
      {card ? (
        <>
          <IconChevronRight size={13} stroke={1.75} className="eva-tk-dim" aria-hidden />
          <span className="eva-tk-crumb-col">{COLUMN_TITLE[card.column]}</span>
        </>
      ) : null}
      <IconChevronRight size={13} stroke={1.75} className="eva-tk-dim" aria-hidden />
      {at.pr ? (
        <UnstyledButton className="eva-tk-crumb" onClick={() => go(ticketHome(at))}>
          {key}
        </UnstyledButton>
      ) : (
        <span className="eva-tk-crumb-cur">
          <span className="eva-tk-dim">{key}</span>
          <span className="eva-tk-crumb-t">{title}</span>
        </span>
      )}
      {at.pr ? (
        <>
          <IconChevronRight size={13} stroke={1.75} className="eva-tk-dim" aria-hidden />
          <span className="eva-tk-crumb-cur">PR #{at.pr.number}</span>
        </>
      ) : null}
    </nav>
  )
}

function IconButton({
  label,
  onClick,
  disabled,
  testid,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  testid: string
  children: ReactNode
}) {
  return (
    <Tooltip label={label} openDelay={300}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={26}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        data-testid={testid}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  )
}

/** Prev/next over the board's order: `i / n`, down for the next card, up for the one before. */
function Stepper({ card, go }: { card: AgentCard | null; go: (p: Place) => void }) {
  const order = useBoardOrder()
  const i = card ? order.findIndex((c) => c.id === card.id) : -1
  if (i < 0) return null
  const step = (d: -1 | 1): void => {
    const next = order[i + d]
    const place = next ? cardPlace(next) : null
    if (place) go(place)
  }
  // A run card opens its own target, not a page: stepping skips nothing, it stops there.
  const can = (d: -1 | 1): boolean => {
    const next = order[i + d]
    return next !== undefined && cardPlace(next) !== null
  }
  return (
    <>
      <span className="eva-tk-pos" data-testid="ticket-pos">
        {i + 1} / {order.length}
      </span>
      <IconButton label="Next" onClick={() => step(1)} disabled={!can(1)} testid="ticket-next">
        <IconChevronDown size={15} stroke={1.5} />
      </IconButton>
      <IconButton
        label="Previous"
        onClick={() => step(-1)}
        disabled={!can(-1)}
        testid="ticket-prev"
      >
        <IconChevronUp size={15} stroke={1.5} />
      </IconButton>
    </>
  )
}

function TopBar({
  at,
  card,
  title,
  linearUrl,
  go,
  leave,
}: {
  at: TicketRef
  card: AgentCard | null
  title: string
  linearUrl: string | null
  go: (p: Place) => void
  leave: () => void
}) {
  const sidebar = useTicketsUi((s) => s.sidebar)
  return (
    <header className="eva-tk-top">
      <Crumbs at={at} card={card} title={title} go={go} leave={leave} />
      <span className="eva-tk-spacer" />
      {linearUrl ? (
        <IconButton
          label="Open in Linear"
          onClick={() => openLink(linearUrl, { reviews: false })}
          testid="ticket-open-linear"
        >
          <IconExternalLink size={15} stroke={1.5} />
        </IconButton>
      ) : null}
      {at.pr ? null : (
        <IconButton
          label={sidebar ? 'Hide properties' : 'Show properties'}
          onClick={() => setSidebarOpen(!sidebar)}
          testid="ticket-sidebar-toggle"
        >
          {sidebar ? (
            <IconLayoutSidebarRightCollapse size={15} stroke={1.5} />
          ) : (
            <IconLayoutSidebarRightExpand size={15} stroke={1.5} />
          )}
        </IconButton>
      )}
      <Stepper card={card} go={go} />
    </header>
  )
}

function SubIssues({ data, go }: { data: TicketData; go: (p: Place) => void }) {
  const children = data.detail?.children ?? []
  if (children.length === 0) return null
  const done = children.filter((c) => c.done).length
  return (
    <section className="eva-tk-subs" data-testid="ticket-subs">
      <h3 className="eva-tk-h3">
        Sub-issues <span className="eva-tk-dim">{`${done}/${children.length}`}</span>
      </h3>
      {children.map((c) => (
        <UnstyledButton
          key={c.key}
          className="eva-tk-subrow"
          onClick={() => go(ticketPlace(c.key))}
        >
          {c.done ? (
            <IconCircleCheckFilled size={15} className="eva-tk-subdone" aria-label="Done" />
          ) : (
            <IconCircle size={15} className="eva-tk-dim" aria-hidden />
          )}
          <span className="eva-tk-dim">{c.key}</span>
          <span className={c.done ? 'eva-tk-dim eva-tk-rel-t' : 'eva-tk-rel-t'}>{c.title}</span>
        </UnstyledButton>
      ))}
    </section>
  )
}

/** Scrolls to the comment box and puts the caret in it (Reply on the summary). */
function focusComposer(): void {
  const box = document.querySelector<HTMLElement>(
    '[data-testid="ticket-page"] [data-ticket-composer]',
  )
  box?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  box?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
}

/** The Linear part of the main column: description, then the comments; or why it's missing. */
function LinearMain({ at, data }: { at: TicketRef; data: TicketData }) {
  if (data.unavailable)
    return (
      <div className="eva-tk-unavail" role="status" data-testid="ticket-unavailable">
        {data.unavailable}
      </div>
    )
  if (data.detail === null)
    return (
      <div className="eva-tk-dim eva-tk-loading" data-testid="ticket-loading">
        Reading {at.id}
      </div>
    )
  return <TicketDescription data={data} />
}

function TicketMain({
  at,
  m,
  now,
  go,
}: {
  at: TicketRef
  m: TicketPageModel
  now: number
  go: (p: Place) => void
}) {
  const { data, card } = m
  const linear = at.kind === 'key'
  return (
    <main className="eva-tk-main">
      <h1 className="eva-tk-title" data-page-title>
        {m.title}
      </h1>
      {linear ? <SummaryCard data={data} card={card} onReply={focusComposer} /> : null}
      {linear ? <LinearMain at={at} data={data} /> : null}
      <SubIssues data={data} go={go} />
      <Resources at={at} card={card} prs={m.prs} linearUrl={m.linearUrl} now={now} go={go} />
      {linear && data.detail ? (
        <>
          <hr className="eva-tk-hr" />
          <Activity data={data} focusCommentId={at.comment} />
        </>
      ) : null}
    </main>
  )
}

/** A PR's page inside the ticket: today's Reviews detail for it, read when it opens. */
function PrRoute({ pr, now }: { pr: TicketPrRef; now: number }) {
  const [loaded, setLoaded] = useState<{ pr: ReviewPr; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { repo, number } = pr
  const load = useMemo(
    () => async (): Promise<void> => {
      setError(null)
      const r = await invoke('reviews.pr', { repo, number })
      if (r.ok) setLoaded({ pr: r.value, at: Date.now() })
      else setError(r.error.message)
    },
    [repo, number],
  )
  useEffect(() => {
    void load()
  }, [load])
  if (!loaded)
    return (
      <div className="eva-tk-dim eva-tk-loading" data-testid="ticket-pr-loading">
        {error ? `Couldn't load ${repo}#${number}: ${error}` : 'Loading the pull request...'}
      </div>
    )
  return (
    <div className="eva-tk-pr eva-rv" data-testid="ticket-pr-page">
      <Detail pr={loaded.pr} fetchedAt={loaded.at} now={now} onRefresh={() => void load()} />
    </div>
  )
}

/** The tab is named like a review tab: `ENG-12 Title`, remembered for the next start. */
function useTabTitle(at: TicketRef, title: string | null): void {
  useEffect(() => {
    if (at.kind === 'key' && title) setReviewTitle(`linear:${at.id}`, `${at.id} ${title}`)
  }, [at.kind, at.id, title])
}

interface TicketPageModel {
  card: AgentCard | null
  data: TicketData
  prs: TicketPr[]
  title: string
  linearUrl: string | null
}

/** The title and Linear link the page knows: Linear's, else the card's. */
function knownOf(detail: TicketData['detail'], card: AgentCard | null) {
  return {
    title: detail?.title ?? card?.title ?? null,
    linearUrl: detail?.url ?? card?.linear?.url ?? null,
  }
}

/** Everything the page shows for `at`: its card, the Linear read, its PRs, title and link. */
function useTicketPage(at: TicketRef): TicketPageModel {
  const cards = useAgentsBoard((s) => s.board?.cards)
  const card = useMemo(() => cardOfRef(cards ?? [], at), [cards, at])
  const key = at.kind === 'key' ? at.id : null
  const data = useTicketData(key)
  const hits = usePrHits(key)
  const prs = useMemo(
    () => pagePrs({ key: key ?? card?.key ?? null, detail: data.detail, card, hits }),
    [key, card, data.detail, hits],
  )
  const known = knownOf(data.detail, card)
  useTabTitle(at, known.title)
  return { card, data, prs, title: known.title ?? at.id, linearUrl: known.linearUrl }
}

function TicketBody({ at, m, now }: { at: TicketRef; m: TicketPageModel; now: number }) {
  const sidebar = useTicketsUi((s) => s.sidebar)
  return (
    <div className="eva-tk-scroll">
      <div className="eva-tk-body" data-side={sidebar ? 'on' : 'off'}>
        <TicketMain at={at} m={m} now={now} go={openPlace} />
        {sidebar ? (
          <TicketSidebar at={at} data={m.data} card={m.card} prs={m.prs} go={openPlace} />
        ) : null}
      </div>
    </div>
  )
}

function TicketView({ at }: { at: TicketRef }) {
  const replace = useReplacePlace()
  const m = useTicketPage(at)
  const sidebar = useTicketsUi((s) => s.sidebar)
  const now = useNow()
  const leave = (): void => backTo(placeOf('board'), replace)
  // Esc: a PR's page goes back to its ticket, the ticket to the board.
  useDismissable(DISMISS_PRIORITY.selection, () =>
    at.pr ? backTo(ticketHome(at), replace) : leave(),
  )
  return (
    <div
      className="eva-tk"
      data-testid="ticket-page"
      data-ticket={at.id}
      data-pr={at.pr ? `${at.pr.repo}#${at.pr.number}` : undefined}
    >
      <TopBar
        at={at}
        card={m.card}
        title={m.title}
        linearUrl={m.linearUrl}
        go={replace}
        leave={leave}
      />
      {at.pr !== null || !sidebar ? (
        <StatusStrip at={at} data={m.data} card={m.card} prs={m.prs} go={replace} />
      ) : null}
      {at.pr ? (
        <PrRoute key={`${at.pr.repo}#${at.pr.number}`} pr={at.pr} now={now} />
      ) : (
        <TicketBody at={at} m={m} now={now} />
      )}
    </div>
  )
}

/** The `ticket:` page: the board's store stays live under it, for prev/next and the card's facts. */
export function TicketPage({ place }: { place: Place }) {
  useEffect(() => startAgentsBoard(), [])
  const page = place.page
  const at = useMemo(() => parseTicketPlace(page), [page])
  if (at === null)
    return (
      <div className="eva-tk-dim eva-tk-loading" data-testid="ticket-place-unknown">
        This ticket page is not one the app can open.
      </div>
    )
  return <TicketView at={at} />
}
