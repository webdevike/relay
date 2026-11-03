import { Skeleton, UnstyledButton, VisuallyHidden } from '@mantine/core'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Virtualizer } from 'virtua'
import {
  ListLayoutProvider,
  gridTemplate,
  type ListColumn,
  type ListDensity,
  type ListLayout,
} from './list-context'
import './list.css'

/** One group of rows under a header, or a headerless run of rows when `label` is absent. */
export interface ListGroup<T> {
  id: string
  /** Header text. Without it the rows run on without a header and cannot collapse. */
  label?: ReactNode
  /** Shown after the label; defaults to the row count. `null` hides it (still loading). */
  count?: number | null
  items: readonly T[]
  /** Shown instead of rows when the group has none (`Nothing here.`, a loading or error line). */
  empty?: ReactNode
  /** Between the header and the rows (an add form, an alert). */
  intro?: ReactNode
  /** Header controls right of the toggle (refresh, a menu). */
  actions?: ReactNode
  /** Labelled groups collapse unless this is false. */
  collapsible?: boolean
  /** Open whatever its collapsed state (a search matched inside it). */
  forceOpen?: boolean
  /** On the group's section; its header toggle gets `-head`, the label `-label`, the count `-count`. */
  testid?: string
}

export interface ListLoading {
  /** Read out to assistive tech and findable by tests, e.g. "Loading jobs". */
  label: string
  testid?: string
}

export interface ListViewProps<T> {
  groups: readonly ListGroup<T>[]
  rowKey: (item: T) => string
  renderRow: (item: T, group: ListGroup<T>) => ReactNode
  density?: ListDensity
  /** Columns mode (option C): a header row, and rows laid out on the column grid. */
  columns?: readonly ListColumn[]
  /** Above the list: a KPI strip (option D) or any other page summary. */
  header?: ReactNode
  /** After the groups (a closing note). */
  footer?: ReactNode
  /** Skeleton rows in place of the groups. */
  loading?: ListLoading | false
  /** Replaces the list (pass a ListEmpty with role alert, or text). */
  error?: ReactNode
  /** Shown when no group has a row and none brings its own empty line. */
  empty?: ReactNode
  /** Collapsed group ids, controlled; pair with onCollapsedChange. */
  collapsed?: ReadonlySet<string>
  /** Initially collapsed group ids when uncontrolled. */
  defaultCollapsed?: readonly string[]
  onCollapsedChange?: (id: string, collapsed: boolean) => void
  /** Every group open (a search is running). */
  forceOpen?: boolean
  /** Window the rows past this many (virtua). Default 150; false never virtualizes. */
  virtualize?: number | false
  className?: string
  'data-testid'?: string
}

type Entry<T> =
  | { kind: 'head'; group: ListGroup<T>; open: boolean }
  | { kind: 'intro'; group: ListGroup<T> }
  | { kind: 'empty'; group: ListGroup<T> }
  | { kind: 'row'; group: ListGroup<T>; item: T }

const VIRTUALIZE_AFTER = 150
const NAV_KEYS: Record<string, true> = { ArrowDown: true, ArrowUp: true, Home: true, End: true }

/** The nearest scrolling ancestor, which a windowed list reads its viewport from. */
function scrollParent(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll' || y === 'overlay') return p
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/** Up, Down, Home and End move focus between rows, in the order they are drawn. */
function moveFocus(e: KeyboardEvent<HTMLElement>): void {
  if (!NAV_KEYS[e.key] || e.altKey || e.metaKey || e.ctrlKey) return
  const target = e.target as HTMLElement
  if (!target.hasAttribute('data-list-row')) return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-list-row][tabindex]')]
  const at = rows.indexOf(target)
  if (at < 0) return
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? rows.length - 1
        : Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))
  e.preventDefault()
  rows[next]?.focus()
  rows[next]?.scrollIntoView?.({ block: 'nearest' })
}

function GroupHead<T>({
  group,
  open,
  density,
  onToggle,
}: {
  group: ListGroup<T>
  open: boolean
  density: ListDensity
  onToggle: () => void
}) {
  const count = group.count === undefined ? group.items.length : group.count
  const id = group.testid
  const label = (
    <>
      <span className="eva-list-glabel" data-testid={id ? `${id}-label` : undefined}>
        {group.label}
      </span>
      {count !== null ? (
        <span className="eva-list-gcount" data-testid={id ? `${id}-count` : undefined}>
          {count}
        </span>
      ) : null}
    </>
  )
  const Chevron = open ? IconChevronDown : IconChevronRight
  return (
    <div className="eva-list-ghead" data-density={density}>
      {group.collapsible === false ? (
        <div className="eva-list-gtoggle" data-testid={id ? `${id}-head` : undefined}>
          {label}
        </div>
      ) : (
        <UnstyledButton
          className="eva-list-gtoggle"
          aria-expanded={open}
          data-testid={id ? `${id}-head` : undefined}
          onClick={onToggle}
        >
          {label}
          <Chevron className="eva-list-gchev" size={14} stroke={1.5} aria-hidden />
        </UnstyledButton>
      )}
      {group.actions ? <span className="eva-list-gactions">{group.actions}</span> : null}
    </div>
  )
}

/** The skeleton a loading list shows: rows shaped like the density's rows. */
function LoadingRows({ loading, density }: { loading: ListLoading; density: ListDensity }) {
  const rows = density === 'compact' ? 4 : 5
  return (
    <div className="eva-list-loading" role="status" data-testid={loading.testid}>
      <VisuallyHidden>{loading.label}</VisuallyHidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="eva-list-row" data-density={density} aria-hidden>
          <span className="eva-list-leading" data-tile={density === 'comfortable' || undefined}>
            <Skeleton height={16} width={16} radius="sm" />
          </span>
          <span className="eva-list-text">
            <Skeleton height={10} width={`${45 + ((i * 17) % 35)}%`} radius="sm" />
            {density === 'comfortable' ? (
              <Skeleton height={8} width={`${60 + ((i * 11) % 25)}%`} radius="sm" />
            ) : null}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Relay's one list (board list-view-options, option B): groups with a count and a collapse
 * toggle over flat rows on hairline dividers. `density="compact"` is option A for sidebars and
 * popovers, `columns` option C for tables like Jobs and Test Bench, and `header` holds option D's
 * KPI strip. Rows are ListRow elements from `renderRow`. Up and Down move between rows; long
 * lists are windowed with virtua inside whatever scrolls them.
 */
export function ListView<T>({
  groups,
  rowKey,
  renderRow,
  density = 'comfortable',
  columns,
  header,
  footer,
  loading,
  error,
  empty,
  collapsed,
  defaultCollapsed,
  onCollapsedChange,
  forceOpen = false,
  virtualize = VIRTUALIZE_AFTER,
  className,
  'data-testid': testid,
}: ListViewProps<T>) {
  const [own, setOwn] = useState<ReadonlySet<string>>(() => new Set(defaultCollapsed ?? []))
  const closed = collapsed ?? own
  const toggle = (id: string): void => {
    const next = !closed.has(id)
    if (collapsed === undefined) {
      const s = new Set(own)
      if (next) s.add(id)
      else s.delete(id)
      setOwn(s)
    }
    onCollapsedChange?.(id, next)
  }

  const entries = useMemo(() => {
    const out: Entry<T>[] = []
    for (const group of groups) {
      const labelled = group.label !== undefined
      const open =
        !labelled ||
        group.collapsible === false ||
        forceOpen ||
        group.forceOpen === true ||
        !closed.has(group.id)
      if (labelled) out.push({ kind: 'head', group, open })
      if (!open) continue
      if (group.intro) out.push({ kind: 'intro', group })
      if (group.items.length === 0) {
        if (group.empty) out.push({ kind: 'empty', group })
      } else for (const item of group.items) out.push({ kind: 'row', group, item })
    }
    return out
  }, [groups, closed, forceOpen])

  const rowCount = entries.reduce((n, e) => n + (e.kind === 'row' ? 1 : 0), 0)
  const windowed = virtualize !== false && rowCount > virtualize
  const body = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLElement | null>(null)
  const [scrollReady, setScrollReady] = useState(false)
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    if (!windowed || !body.current) return
    const s = scrollParent(body.current)
    scroller.current = s
    const top =
      body.current.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop
    if (top !== startMargin) setStartMargin(top)
    if (!scrollReady) setScrollReady(true)
  })

  const layout = useMemo<ListLayout>(
    () => ({ density, columns: columns && columns.length > 0 ? columns : null }),
    [density, columns],
  )
  const style = layout.columns
    ? ({ '--eva-list-grid': gridTemplate(layout.columns) } as CSSProperties)
    : undefined

  const draw = (e: Entry<T>): ReactNode => {
    switch (e.kind) {
      case 'head':
        return (
          <GroupHead
            group={e.group}
            open={e.open}
            density={density}
            onToggle={() => toggle(e.group.id)}
          />
        )
      case 'intro':
        return <div className="eva-list-intro">{e.group.intro}</div>
      case 'empty':
        return <div className="eva-list-note">{e.group.empty}</div>
      case 'row':
        return renderRow(e.item, e.group)
    }
  }
  const keyOf = (e: Entry<T>): string =>
    e.kind === 'row' ? `r:${e.group.id}:${rowKey(e.item)}` : `${e.kind}:${e.group.id}`

  let content: ReactNode
  if (error !== undefined && error !== null && error !== false) {
    content = <div className="eva-list-state">{error}</div>
  } else if (loading) {
    content = <LoadingRows loading={loading} density={density} />
  } else if (empty !== undefined && groups.every((g) => g.items.length === 0 && !g.empty)) {
    content = <div className="eva-list-state">{empty}</div>
  } else if (windowed) {
    content = (
      <div ref={body} className="eva-list-body">
        {scrollReady ? (
          <Virtualizer scrollRef={scroller} startMargin={startMargin} data={entries}>
            {(e) => <div key={keyOf(e)}>{draw(e)}</div>}
          </Virtualizer>
        ) : null}
      </div>
    )
  } else {
    // Sections keep each group's header and rows together for assistive tech and tests.
    content = (
      <div ref={body} className="eva-list-body">
        {groups.map((g) => {
          const mine = entries.filter((e) => e.group === g)
          if (mine.length === 0) return null
          return g.label !== undefined || g.testid ? (
            <section
              key={g.id}
              className="eva-list-group"
              data-list-group={g.id}
              data-testid={g.testid}
              aria-label={typeof g.label === 'string' ? g.label : undefined}
            >
              {mine.map((e) => (
                <Fragment key={keyOf(e)}>{draw(e)}</Fragment>
              ))}
            </section>
          ) : (
            <Fragment key={g.id}>
              {mine.map((e) => (
                <Fragment key={keyOf(e)}>{draw(e)}</Fragment>
              ))}
            </Fragment>
          )
        })}
      </div>
    )
  }

  return (
    <ListLayoutProvider value={layout}>
      <div
        className={`eva-list${className ? ` ${className}` : ''}`}
        data-density={density}
        data-columns={layout.columns ? true : undefined}
        data-windowed={windowed || undefined}
        data-testid={testid}
        style={style}
        onKeyDown={moveFocus}
      >
        {header !== undefined && header !== null ? (
          <div className="eva-list-header">{header}</div>
        ) : null}
        {layout.columns && !error && !(empty !== undefined && rowCount === 0) ? (
          <div className="eva-list-colhead" role="presentation">
            {layout.columns.map((c, i) => (
              <span
                key={c.id}
                className="eva-list-th"
                data-align={i === 0 ? 'start' : (c.align ?? 'center')}
              >
                {c.label}
              </span>
            ))}
          </div>
        ) : null}
        {content}
        {footer !== undefined && footer !== null ? (
          <div className="eva-list-footer">{footer}</div>
        ) : null}
      </div>
    </ListLayoutProvider>
  )
}
