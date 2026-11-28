// Inline comment threads on a ticket's description (PLAN T3.1). The description (`TicketDescription`)
// registers its element here; the activity, which owns every write and private ask, draws into it
// through portals: an amber, underlined highlight over each thread's quote, the selection toolbar
// (Comment, Quote), one popover with the open thread or a new comment's box, and below the
// description "Resolved (n)" and the threads whose text was edited away.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ActionIcon, Badge, Button } from '@mantine/core'
import { IconX } from '@tabler/icons-react'
import { EvaPopover } from '../overlay'
import type { Thread } from './activity-model'
import { contextAt, locate, placeThreads, type AnchorContext } from './inline-anchor'
import { SelectionToolbar, type Box } from './SelectionToolbar'

/** The description's parts the inline threads draw into. */
export interface InlineHost {
  /** The rendered description (its text is what quotes are found in). */
  body: HTMLElement
  /** An overlay over it, `position: absolute; inset: 0`. */
  layer: HTMLElement
  /** Below it: the Resolved toggle and the threads on removed text. */
  foot: HTMLElement
}

const hosts = new Map<string, InlineHost>()
const listeners = new Set<() => void>()
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The ref `TicketDescription` puts on its wrapper (with the three `data-inline-*` parts inside). */
export function useInlineHostRef(key: string): (el: HTMLElement | null) => void {
  return useCallback(
    (el: HTMLElement | null) => {
      const part = (name: string) => el?.querySelector<HTMLElement>(`[data-inline-${name}]`)
      const body = part('body')
      const layer = part('layer')
      const foot = part('foot')
      if (body && layer && foot) hosts.set(key, { body, layer, foot })
      else hosts.delete(key)
      for (const cb of [...listeners]) cb()
    },
    [key],
  )
}

/** The ticket's description parts while it is on the page. */
export function useInlineHost(key: string): InlineHost | null {
  return useSyncExternalStore(subscribe, () => hosts.get(key) ?? null)
}

/** A new inline comment: the selected words, where they sat, and where its box opens. */
export interface InlineDraft {
  quote: string
  anchor: AnchorContext
  at: Box
}

interface Placed {
  id: string
  ambiguous: boolean
  resolved: boolean
  rects: Box[]
}

function textNodes(body: HTMLElement): Text[] {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  const out: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text)
  return out
}

/** The DOM range of rendered offsets `[start, end)` among `nodes`. */
function rangeOf(nodes: Text[], start: number, end: number): Range | null {
  const lengths = nodes.map((n) => n.data.length)
  const a = locate(lengths, start)
  const b = locate(lengths, end)
  if (!a || !b) return null
  const r = document.createRange()
  r.setStart(nodes[a.index]!, a.offset)
  r.setEnd(nodes[b.index]!, b.offset)
  return r
}

function boxesOf(r: Range, origin: DOMRect): Box[] {
  // jsdom has no layout: nothing to draw.
  if (typeof r.getClientRects !== 'function') return []
  return [...r.getClientRects()]
    .filter((c) => c.width > 0 && c.height > 0)
    .map((c) => ({
      top: c.top - origin.top,
      left: c.left - origin.left,
      width: c.width,
      height: c.height,
    }))
}

type Placement = { shown: Placed[]; removed: string[] }

/** What placing depends on: each root's quote, saved context and resolved state. */
const placingKey = (threads: readonly Thread[]): string =>
  JSON.stringify(
    threads.map((t) => [t.root.id, t.root.quotedText, t.root.anchor, t.root.resolvedAt]),
  )

function measure(host: InlineHost, threads: readonly Thread[]): Placement {
  const nodes = textNodes(host.body)
  const joined = nodes.map((n) => n.data).join('')
  const roots = threads.map((t) => t.root)
  const { anchored, removed } = placeThreads(joined, roots)
  const origin = host.layer.getBoundingClientRect()
  const resolved = new Set(roots.filter((r) => r.resolvedAt !== null).map((r) => r.id))
  const shown = anchored.map((a) => {
    const r = rangeOf(nodes, a.start, a.end)
    const rects = r ? boxesOf(r, origin) : []
    return { id: a.id, ambiguous: a.ambiguous, resolved: resolved.has(a.id), rects }
  })
  return { shown, removed }
}

/** Each thread's highlight boxes, and the threads whose quote is gone; kept current on resize. */
function usePlacement(host: InlineHost, text: string, threads: readonly Thread[]): Placement {
  const [placed, setPlaced] = useState<Placement>({ shown: [], removed: [] })
  const latest = useRef(threads)
  latest.current = threads
  const key = placingKey(threads)
  useLayoutEffect(() => {
    const update = (): void => {
      const next = measure(host, latest.current)
      // Same boxes: no new render (a resize that moved nothing).
      setPlaced((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    update()
    // jsdom (unit tests) has no ResizeObserver: placed once.
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(host.body)
    return () => ro.disconnect()
  }, [host, text, key])
  return placed
}

/** The selection inside the description as a new comment's draft; null when there is none. */
function selectedIn(host: InlineHost): InlineDraft | null {
  const s = window.getSelection()
  if (!s || s.rangeCount === 0 || s.isCollapsed) return null
  const range = s.getRangeAt(0)
  const quote = s.toString().trim()
  if (!quote || !host.body.contains(range.commonAncestorContainer)) return null
  // Rendered offsets: the text from the description's start to the selection's.
  const before = document.createRange()
  before.setStart(host.body, 0)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  const joined = textNodes(host.body)
    .map((n) => n.data)
    .join('')
  const span = { start, end: start + range.toString().length }
  const [at] = boxesOf(range, host.layer.getBoundingClientRect())
  return at ? { quote, anchor: contextAt(joined, span), at } : null
}

/** The words selected in the description, where they sit and the box over them; null when none. */
function useSelected(host: InlineHost): InlineDraft | null {
  const [sel, setSel] = useState<InlineDraft | null>(null)
  useEffect(() => {
    const read = (): void => setSel(selectedIn(host))
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [host])
  return sel
}

/** Opens the thread whose highlight was clicked (highlights let clicks through to the text). */
function useHitTest(host: InlineHost, shown: readonly Placed[], onOpen: (id: string) => void) {
  useEffect(() => {
    const click = (e: MouseEvent): void => {
      if (!window.getSelection()?.isCollapsed) return
      const origin = host.layer.getBoundingClientRect()
      const x = e.clientX - origin.left
      const y = e.clientY - origin.top
      const hit = shown.find((p) =>
        p.rects.some(
          (r) => x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height,
        ),
      )
      if (hit) onOpen(hit.id)
    }
    host.body.addEventListener('click', click)
    return () => host.body.removeEventListener('click', click)
  }, [host, shown, onOpen])
}

function Highlights({
  shown,
  quoteOf,
  onOpen,
}: {
  shown: readonly Placed[]
  quoteOf: (id: string) => string
  onOpen: (id: string) => void
}) {
  return shown.flatMap((p) =>
    p.rects.map((r, i) => (
      <button
        key={`${p.id}-${String(i)}`}
        type="button"
        className="eva-tk-hl"
        style={r}
        // One tab stop per thread; the rest of its lines are drawn only.
        tabIndex={i === 0 ? 0 : -1}
        aria-hidden={i === 0 ? undefined : true}
        aria-label={i === 0 ? `Comment thread on “${quoteOf(p.id)}”` : undefined}
        data-resolved={p.resolved || undefined}
        data-root-id={p.id}
        data-testid="inline-highlight"
        onClick={() => onOpen(p.id)}
      />
    )),
  )
}

export interface InlineThreadsProps {
  host: InlineHost
  /** The description's source: re-placed when it changes. */
  text: string
  /** The inline threads (roots on the description). */
  threads: readonly Thread[]
  canComment: boolean
  open: string | null
  onOpen: (rootId: string | null) => void
  draft: InlineDraft | null
  onDraft: (d: InlineDraft | null) => void
  renderThread: (t: Thread) => ReactNode
  renderDraft: (d: InlineDraft) => ReactNode
  onQuote: (text: string) => void
}

function Foot({
  removed,
  resolvedCount,
  showResolved,
  onToggle,
  renderThread,
}: {
  removed: readonly Thread[]
  resolvedCount: number
  showResolved: boolean
  onToggle: () => void
  renderThread: (t: Thread) => ReactNode
}) {
  return (
    <>
      {resolvedCount > 0 ? (
        <Button
          size="compact-xs"
          variant={showResolved ? 'light' : 'subtle'}
          color="gray"
          onClick={onToggle}
          aria-pressed={showResolved}
          data-testid="inline-resolved-toggle"
        >
          {`Resolved (${String(resolvedCount)})`}
        </Button>
      ) : null}
      {removed.length > 0 ? (
        <div className="eva-tk-inline-removed" data-testid="inline-removed">
          <div className="eva-rv-dim eva-rv-small">Comment on removed text</div>
          {removed.map((t) => (
            <div key={t.root.id}>{renderThread(t)}</div>
          ))}
        </div>
      ) : null}
    </>
  )
}

/** The one popover: a new comment's box at the selection, or the open thread at its quote. */
function ThreadPopover({
  at,
  ambiguous,
  body,
  onClose,
}: {
  at: Box | null
  ambiguous: boolean
  body: ReactNode
  onClose: () => void
}) {
  return (
    <EvaPopover
      opened={at !== null && body !== null}
      onChange={(o) => {
        if (!o) onClose()
      }}
      position="bottom-start"
      width={440}
      // Its menus and confirms open in their own layers: a click there must not close it.
      closeOnClickOutside={false}
      trapFocus={false}
    >
      <EvaPopover.Target>
        <div className="eva-tk-inline-target" style={at ?? undefined} />
      </EvaPopover.Target>
      <EvaPopover.Dropdown className="eva-tk-inline-pop" data-testid="inline-thread-popover">
        <div className="eva-tk-inline-pophead">
          {ambiguous ? (
            <Badge size="xs" variant="light" color="yellow" data-testid="inline-ambiguous">
              Ambiguous: shown on first match
            </Badge>
          ) : null}
          <span className="eva-rv-spacer" />
          <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Close" onClick={onClose}>
            <IconX size={14} />
          </ActionIcon>
        </div>
        {body}
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}

/** What the popover shows: the draft's box at the selection, else the open thread at its quote. */
function popoverOf(
  p: InlineThreadsProps,
  placed: Placement,
  byId: ReadonlyMap<string, Thread>,
): { at: Box | null; ambiguous: boolean; body: ReactNode } {
  if (p.draft) return { at: p.draft.at, ambiguous: false, body: p.renderDraft(p.draft) }
  const thread = p.open ? byId.get(p.open) : undefined
  // A resolved thread opened from a link shows at its quote even while resolved ones are hidden.
  const at = placed.shown.find((x) => x.id === p.open)
  return {
    at: at?.rects[0] ?? null,
    ambiguous: at?.ambiguous === true,
    body: thread ? p.renderThread(thread) : null,
  }
}

export function InlineThreads(p: InlineThreadsProps) {
  const [showResolved, setShowResolved] = useState(false)
  const placed = usePlacement(p.host, p.text, p.threads)
  const shown = placed.shown.filter((x) => showResolved || !x.resolved)
  const selected = useSelected(p.host)
  const { onOpen, onDraft } = p
  const open = useCallback(
    (id: string) => {
      onDraft(null)
      onOpen(id)
    },
    [onOpen, onDraft],
  )
  useHitTest(p.host, shown, open)
  const byId = new Map(p.threads.map((t) => [t.root.id, t]))
  const close = (): void => {
    onDraft(null)
    onOpen(null)
  }
  const pop = popoverOf(p, placed, byId)
  const layer = (
    <>
      <Highlights
        shown={shown}
        quoteOf={(id) => byId.get(id)?.root.quotedText ?? ''}
        onOpen={open}
      />
      {selected && !p.draft ? (
        <SelectionToolbar
          at={{ ...selected.at, top: selected.at.top - 30 }}
          canComment={p.canComment}
          onComment={() => {
            onOpen(null)
            onDraft(selected)
          }}
          onQuote={() => p.onQuote(selected.quote)}
        />
      ) : null}
      <ThreadPopover at={pop.at} ambiguous={pop.ambiguous} body={pop.body} onClose={close} />
    </>
  )
  const foot = (
    <Foot
      removed={placed.removed.flatMap((id) => byId.get(id) ?? [])}
      resolvedCount={p.threads.filter((t) => t.root.resolvedAt !== null).length}
      showResolved={showResolved}
      onToggle={() => setShowResolved((s) => !s)}
      renderThread={p.renderThread}
    />
  )
  return (
    <>
      {createPortal(layer, p.host.layer)}
      {createPortal(foot, p.host.foot)}
    </>
  )
}
