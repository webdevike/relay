import './turn-minimap.css'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconBookmark, IconBookmarkFilled, IconFilter } from '@tabler/icons-react'
import type { VListHandle } from 'virtua'
import { toggleBookmark, useBookmarks } from './bookmarks'
import type { TurnFlag } from './flags'
import { compressTicks, stepTurn, turnAt, visibleTurns, type Turn } from './turns'

/** Height of one tick's slot, px: the pitch ticks are laid out and compressed at. */
export const TICK_PITCH = 10
/** Share of the log's height the column may take. */
const MAX_SHARE = 0.7
/** Height the filter button takes above the ticks, px. */
const FILTER_ROOM = 28
/** How long the card stays after the pointer leaves, ms (the gap to it is crossed). */
const LEAVE_MS = 160

/** How long after a jump the next Alt+Up/Down chains from it, ms. */
const SETTLE_MS = 700

const FLAG_LABEL: Record<TurnFlag, string> = {
  ask: 'Asked you something',
  shipped: 'Said something shipped',
}

/** Slots the column fits in a log `height` px tall. */
export function slotsFor(height: number): number {
  return Math.max(1, Math.floor((height * MAX_SHARE - FILTER_ROOM) / TICK_PITCH))
}

interface View {
  active: number
  from: number
  to: number
}

/**
 * ChatGPT-style turn navigator: a fixed column of thin ticks at the log's left edge, one per turn
 * (a run of turns per tick when they do not fit, like a scrollbar map). The tick of the turn on
 * screen is longer and brighter. A hover card shows the turn's message and the start of its reply
 * with a bookmark toggle; a click jumps there. A dot marks a turn that wants Isaac. The filter
 * button at the top keeps only flagged and bookmarked turns. Alt+Up and Alt+Down step between turns.
 */
export function TurnMinimap({
  turns,
  thread,
  paneId,
  listRef,
  subscribe,
  jump,
  shown,
}: {
  turns: readonly Turn[]
  /** Bookmarks live under this key. */
  thread: string
  paneId: string
  listRef: RefObject<VListHandle | null>
  /** Calls back on every scroll of the log; returns its unsubscribe. */
  subscribe: (fn: () => void) => () => void
  /** Brings a turn to the top of the log and flashes it. */
  jump: (turn: Turn) => void
  /** The pane is on screen (it stays mounted, hidden, while another page shows). */
  shown: boolean
}) {
  const bookmarks = useBookmarks(thread)
  const [only, setOnly] = useState(false)
  const list = useMemo(
    () => (only ? turns.filter((t) => t.flag !== null || bookmarks.has(t.key)) : turns),
    [only, turns, bookmarks],
  )
  const root = useRef<HTMLElement>(null)
  const [height, setHeight] = useState(600)
  const [view, setView] = useState<View>({ active: 0, from: 0, to: 0 })
  const [hover, setHover] = useState<number | null>(null)
  const leave = useRef<number | undefined>(undefined)

  useLayoutEffect(() => {
    const host = root.current?.parentElement
    if (!host) return
    // A hidden pane measures 0: keep the last height until it shows again.
    const measure = (): void => {
      if (host.clientHeight > 0) setHeight(host.clientHeight)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const offsets = (): { top: number; bottom: number; at: (item: number) => number } | null => {
    const h = listRef.current
    if (!h || h.viewportSize === 0) return null
    return {
      top: h.scrollOffset,
      bottom: h.scrollOffset + h.viewportSize,
      at: (item) => h.getItemOffset(item),
    }
  }

  // The turn on screen follows the scroll and the list itself.
  const place = (): void => {
    const o = offsets()
    const h = listRef.current
    if (!o || !h || list.length === 0) return
    const end = h.scrollSize - o.bottom <= 2
    const active = end ? list.length - 1 : turnAt(list, o.at, o.top + 8)
    const [from, to] = visibleTurns(list, o.at, o.top, o.bottom, active)
    setView((v) =>
      v.active === active && v.from === from && v.to === to ? v : { active, from, to },
    )
  }
  const placeRef = useRef(place)
  placeRef.current = place
  useLayoutEffect(() => {
    place()
  }, [list, height])
  useEffect(() => {
    let frame = 0
    const off = subscribe(() => {
      if (frame === 0)
        frame = requestAnimationFrame(() => {
          frame = 0
          placeRef.current()
        })
    })
    return () => {
      off()
      cancelAnimationFrame(frame)
    }
  }, [subscribe])

  /** The turn the last jump went to, and when: rapid steps chain from it while the list settles. */
  const cursor = useRef<{ key: string; at: number } | null>(null)
  const go = (t: Turn): void => {
    cursor.current = { key: t.key, at: performance.now() }
    jump(t)
  }
  const step = (dir: 1 | -1): number | null => {
    const o = offsets()
    return o === null ? null : stepTurn(list, o.at, o.top, dir)
  }
  // Alt+Up and Alt+Down: the previous and the next turn, while focus is in this chat.
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[data-chat-pane]')?.getAttribute('data-chat-pane') !== paneId) return
      const dir = e.key === 'ArrowDown' ? 1 : -1
      e.preventDefault()
      // A step right after a jump goes on from where that jump is headed, not from the scroll
      // position the list has not reached yet.
      const c = cursor.current
      const from =
        c !== null && performance.now() - c.at < SETTLE_MS
          ? list.findIndex((t) => t.key === c.key)
          : -1
      const to = from >= 0 ? (list[from + dir] === undefined ? null : from + dir) : step(dir)
      if (to !== null) go(list[to]!)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  useEffect(() => () => window.clearTimeout(leave.current), [])

  const ticks = useMemo(
    () => compressTicks(list, bookmarks, slotsFor(height), view.active, [view.from, view.to]),
    [list, bookmarks, height, view],
  )
  if (turns.length < 2) return null

  const open = (i: number): void => {
    window.clearTimeout(leave.current)
    setHover(i)
  }
  const close = (): void => {
    window.clearTimeout(leave.current)
    leave.current = window.setTimeout(() => setHover(null), LEAVE_MS)
  }
  const tick = hover === null ? undefined : ticks[hover]
  const turn = tick === undefined ? undefined : list[tick.rep]

  return (
    <nav
      ref={root}
      className="eva-tm"
      data-testid="turn-minimap"
      aria-label="Turns"
      onMouseLeave={close}
      onMouseEnter={() => window.clearTimeout(leave.current)}
    >
      <div className="eva-tm-col">
        <Tooltip label={only ? 'Show all turns' : 'Only flagged and bookmarked'} position="right">
          <ActionIcon
            variant="subtle"
            size="var(--eva-kit-control-xs)"
            className="eva-tm-filter"
            data-testid="turn-minimap-filter"
            aria-label={only ? 'Show all turns' : 'Only flagged and bookmarked'}
            aria-pressed={only}
            onClick={() => setOnly((v) => !v)}
          >
            <IconFilter size={12} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
        <div className="eva-tm-ticks" data-testid="turn-minimap-ticks" onBlur={close}>
          {ticks.map((t, i) => {
            const rep = list[t.rep]!
            return (
              <button
                key={i}
                type="button"
                className="eva-tm-tick"
                data-testid="turn-tick"
                data-turn={rep.key}
                data-state={t.state}
                data-flag={t.flag ?? undefined}
                data-bookmarked={t.bookmarked || undefined}
                aria-label={rep.title || 'Turn'}
                aria-current={t.state === 'active' ? 'location' : undefined}
                onMouseEnter={() => open(i)}
                onFocus={() => open(i)}
                onClick={() => go(rep)}
              >
                <span className="eva-tm-bar" />
                {t.flag !== null ? <span className="eva-tm-dot" /> : null}
              </button>
            )
          })}
          {ticks.length === 0 ? (
            <div className="eva-tm-empty" data-testid="turn-minimap-empty">
              Nothing flagged
            </div>
          ) : null}
        </div>
      </div>
      {turn !== undefined && tick !== undefined ? (
        <TurnCard
          // A new tick restarts the card where that tick is.
          key={tick.rep}
          turn={turn}
          more={tick.last - tick.first}
          bookmarked={bookmarks.has(turn.key)}
          anchor={root.current?.querySelectorAll<HTMLElement>('.eva-tm-tick')[hover!] ?? null}
          onBookmark={() => toggleBookmark(thread, turn.key)}
        />
      ) : null}
    </nav>
  )
}

/** The card a hovered tick opens: the message, the start of its reply, a bookmark toggle. */
function TurnCard({
  turn,
  more,
  bookmarked,
  anchor,
  onBookmark,
}: {
  turn: Turn
  /** Further turns the tick stands for. */
  more: number
  bookmarked: boolean
  anchor: HTMLElement | null
  onBookmark: () => void
}) {
  const card = useRef<HTMLDivElement>(null)
  // Beside the tick, kept inside the log (the nearest positioned ancestor of the column).
  useLayoutEffect(() => {
    const el = card.current
    if (!el || !anchor) return
    const a = anchor.getBoundingClientRect()
    const bounds = el.closest('.eva-log')?.getBoundingClientRect()
    const h = el.offsetHeight
    let top = a.top + a.height / 2 - h / 2
    if (bounds) top = Math.min(Math.max(top, bounds.top + 8), bounds.bottom - h - 8)
    el.style.top = `${top}px`
    el.style.left = `${a.right}px`
  }, [anchor, turn])
  return (
    <div ref={card} className="eva-tm-card-wrap" data-testid="turn-card">
      <div className="eva-tm-card">
        <div className="eva-tm-card-head">
          <span className="eva-tm-title" data-testid="turn-card-title">
            {turn.title || 'Turn'}
          </span>
          <ActionIcon
            variant="subtle"
            size="var(--eva-kit-control-xs)"
            className="eva-tm-bookmark"
            data-testid="turn-card-bookmark"
            aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this turn'}
            aria-pressed={bookmarked}
            onClick={onBookmark}
          >
            {bookmarked ? (
              <IconBookmarkFilled size={14} stroke={1.5} />
            ) : (
              <IconBookmark size={14} stroke={1.5} />
            )}
          </ActionIcon>
        </div>
        {turn.reply !== '' ? (
          <p className="eva-tm-reply" data-testid="turn-card-reply">
            {turn.reply}
          </p>
        ) : null}
        {turn.flag !== null || more > 0 ? (
          <div className="eva-tm-card-foot">
            {turn.flag !== null ? (
              <span className="eva-tm-flag" data-testid="turn-card-flag">
                <span className="eva-tm-dot" />
                {FLAG_LABEL[turn.flag]}
              </span>
            ) : null}
            {more > 0 ? <span>{`${more} more turns here`}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
