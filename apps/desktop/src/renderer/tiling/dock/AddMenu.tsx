import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ActionIcon, Kbd, TextInput, Tooltip } from '@mantine/core'
import {
  IconArrowsMaximize,
  IconChevronRight,
  IconLayoutColumns,
  IconLayoutRows,
  IconMessagePlus,
  IconPlus,
  IconSchema,
} from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { newBoard, useCanvasList, useCanvasListSurface } from '../../canvas/canvas-store'
import { EvaPopover } from '../../overlay'
import {
  focusPaneById,
  newChatTabIn,
  openPlaceInPane,
  splitAt,
  useTiling,
  zoomPane,
} from '../tiling-store'
import { openToolIn, TOOLS } from '../tools'

interface Row {
  id: string
  label: string
  icon: ReactNode
  hint?: string
  /** Opens a second step instead of acting. */
  more?: boolean
  /** Starts a group after a divider. */
  divided?: boolean
  run: () => void
}

const icon = (I: typeof IconPlus) => <I size={16} stroke={1.5} />

/** Past this many rows the filter field shows before anything is typed. */
const FILTER_AT = 8

/** The one + of a pane, right after its last tab: add a tool, a board, split, maximize, new chat. */
export function AddMenu({ pane, app, testid }: { pane: string; app: boolean; testid: string }) {
  const [opened, setOpened] = useState(false)
  return (
    <EvaPopover opened={opened} onChange={setOpened} position="bottom-start" width={220}>
      <EvaPopover.Target>
        <Tooltip label="Add a tab or split" position="bottom" openDelay={400} disabled={opened}>
          <ActionIcon
            variant="subtle"
            size={28}
            className="eva-tabbar-btn"
            aria-label="Add a tab or split"
            aria-haspopup="menu"
            aria-expanded={opened}
            data-testid={testid}
            onClick={() => setOpened((o) => !o)}
          >
            {icon(IconPlus)}
          </ActionIcon>
        </Tooltip>
      </EvaPopover.Target>
      <EvaPopover.Dropdown data-testid={`pane-add-menu-${pane}`} className="eva-add-menu">
        {opened ? <MenuBody pane={pane} app={app} close={() => setOpened(false)} /> : null}
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}

function MenuBody({ pane, app, close }: { pane: string; app: boolean; close: () => void }) {
  useCanvasListSurface()
  const [step, setStep] = useState<'root' | 'canvas'>('root')
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const zoomed = useTiling((s) => s.zoom === pane)
  const boards = useCanvasList((s) => s.entries)
  const listRef = useRef<HTMLDivElement>(null)
  const act = (fn: () => void) => () => {
    close()
    fn()
  }

  const rows = useMemo<Row[]>(() => {
    if (step === 'canvas') {
      return [
        {
          id: 'canvas-new',
          label: 'New board',
          icon: icon(IconPlus),
          run: act(() => {
            focusPaneById(pane)
            void newBoard('here')
          }),
        },
        ...(boards ?? []).map((b) => ({
          id: `canvas-${b.slug}`,
          label: b.title,
          icon: icon(IconSchema),
          run: act(() => openPlaceInPane(placeOf('canvas', { canvas: b.slug }), pane)),
        })),
      ]
    }
    const tools: Row[] = TOOLS.map((t) => ({
      id: `tool-${t.id}`,
      label: t.label,
      icon: icon(t.Icon),
      hint: t.shortcut,
      more: t.id === 'canvas' || undefined,
      run:
        t.id === 'canvas'
          ? () => {
              setStep('canvas')
              setQuery('')
              setAt(0)
            }
          : act(() => openToolIn(t.add, pane)),
    }))
    const extra: Row[] = [
      {
        id: 'split-right',
        label: 'Split right',
        icon: icon(IconLayoutColumns),
        hint: '⌘\\',
        divided: true,
        run: act(() => splitAt(pane, 'right')),
      },
      {
        id: 'split-down',
        label: 'Split down',
        icon: icon(IconLayoutRows),
        hint: '⇧⌘\\',
        run: act(() => splitAt(pane, 'down')),
      },
    ]
    if (!zoomed) {
      extra.push({
        id: 'zoom',
        label: 'Maximize',
        icon: icon(IconArrowsMaximize),
        hint: '⌥⌘↩',
        run: act(() => zoomPane(pane, true)),
      })
    }
    if (app) {
      extra.push({
        id: 'new-chat',
        label: 'New chat',
        icon: icon(IconMessagePlus),
        run: act(() => newChatTabIn()),
      })
    }
    return [...tools, ...extra]
    // `act` closes over `close` only, stable for this open menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, boards, zoomed, app, pane])

  const q = query.trim().toLowerCase()
  const shown = q === '' ? rows : rows.filter((r) => r.label.toLowerCase().includes(q))
  const current = Math.min(at, Math.max(shown.length - 1, 0))
  const filtering = query !== '' || rows.length > FILTER_AT

  useEffect(() => {
    if (!filtering) listRef.current?.focus()
  }, [filtering, step])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = shown.length
      if (n > 0) setAt((current + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      shown[current]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (step === 'canvas') {
        setStep('root')
        setQuery('')
        setAt(0)
      } else close()
    } else if (
      !filtering &&
      e.key.length === 1 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key !== ' '
    ) {
      e.preventDefault()
      setQuery(e.key)
      setAt(0)
    }
  }

  return (
    <div onKeyDown={onKey}>
      {filtering ? (
        <TextInput
          size="xs"
          autoFocus
          className="eva-add-menu-filter"
          placeholder={step === 'canvas' ? 'Filter boards' : 'Filter'}
          aria-label="Filter"
          data-testid={`pane-add-filter-${pane}`}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            setAt(0)
          }}
        />
      ) : null}
      <div
        ref={listRef}
        role="menu"
        tabIndex={-1}
        className="eva-add-menu-list"
        aria-activedescendant={shown[current] ? `add-${pane}-${shown[current].id}` : undefined}
      >
        {shown.map((r, i) => (
          <div key={r.id}>
            {r.divided && q === '' ? <div className="eva-add-menu-divider" role="separator" /> : null}
            <div
              id={`add-${pane}-${r.id}`}
              role="menuitem"
              className="eva-add-menu-row"
              data-active={i === current || undefined}
              data-testid={`pane-add-${r.id}-${pane}`}
              onMouseEnter={() => setAt(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={r.run}
            >
              {r.icon}
              <span className="eva-add-menu-label">{r.label}</span>
              {r.hint ? <Kbd size="xs">{r.hint}</Kbd> : null}
              {r.more ? <IconChevronRight size={14} stroke={1.5} /> : null}
            </div>
          </div>
        ))}
        {shown.length === 0 ? <div className="eva-add-menu-empty">Nothing matches</div> : null}
      </div>
    </div>
  )
}
