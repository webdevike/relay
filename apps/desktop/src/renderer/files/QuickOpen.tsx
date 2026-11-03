import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { IconSearch } from '@tabler/icons-react'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { FileIcon } from './FileIcon'
import { loadAllFiles, openFile, setQuickOpen, useSpace } from './files-store'
import { parseQuery, rankPaths, type Ranked } from './fuzzy'
import { nameOf, parentOf } from './tree-model'

const LIMIT = 60
const NO_RECENT: string[] = []

/** Marks the matched characters of `text` (offset into the scored path). */
function highlight(text: string, offset: number, positions: ReadonlySet<number>): ReactNode[] {
  const out: ReactNode[] = []
  let run = ''
  let marked = false
  const flush = (key: number): void => {
    if (!run) return
    out.push(marked ? <mark key={key}>{run}</mark> : <span key={key}>{run}</span>)
    run = ''
  }
  for (let i = 0; i < text.length; i++) {
    const m = positions.has(i + offset)
    if (m !== marked) {
      flush(i)
      marked = m
    }
    run += text[i]
  }
  flush(text.length)
  return out
}

function Item({ r, active, onOpen }: { r: Ranked; active: boolean; onOpen: () => void }) {
  const name = nameOf(r.path)
  const dir = parentOf(r.path)
  const positions = useMemo(() => new Set(r.positions), [r.positions])
  return (
    <div
      role="option"
      aria-selected={active}
      className="eva-files-qo-item"
      data-active={active || undefined}
      data-testid="quick-open-item"
      onMouseDown={(e) => {
        e.preventDefault()
        onOpen()
      }}
    >
      <FileIcon name={name} kind="file" />
      <span className="eva-files-qo-name">
        {highlight(name, r.path.length - name.length, positions)}
      </span>
      {dir ? <span className="eva-files-qo-dir">{highlight(dir, 0, positions)}</span> : null}
    </div>
  )
}

/** Cmd+P: fuzzy file picker over every non-ignored file of the root. */
export function QuickOpen({ root }: { root: string }) {
  const files = useSpace((w) => w.allFiles, null)
  const recent = useSpace((w) => w.recent, NO_RECENT)
  // Esc reaches the app's dismiss ladder before the input sees it.
  useDismissable(DISMISS_PRIORITY.overlay, () => setQuickOpen(false))
  const [raw, setRaw] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (files === null) void loadAllFiles(root)
  }, [root, files])
  useEffect(() => input.current?.focus(), [])

  const { query, line, column } = parseQuery(raw)
  // Before typing: recent files, then the shallowest files (the root's own first).
  const shallow = useMemo(() => {
    const depth = (p: string): number => p.split('/').length
    return [...(files ?? [])]
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
      .slice(0, LIMIT * 2)
  }, [files])
  const results = useMemo<Ranked[]>(() => {
    const all = files ?? []
    if (query === '') {
      const known = new Set(all)
      const rec = recent.filter((p) => files === null || known.has(p))
      const rest = shallow.filter((p) => !rec.includes(p))
      return [...rec, ...rest].slice(0, LIMIT).map((path) => ({ path, score: 0, positions: [] }))
    }
    const rank = new Map(recent.map((p, i) => [p, 1 - i / recent.length]))
    return rankPaths(query, all, LIMIT, (p) => rank.get(p) ?? 0)
  }, [files, shallow, recent, query])

  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const open = (r: Ranked | undefined): void => {
    if (!r) return
    setQuickOpen(false)
    openFile(root, r.path, { pin: true, line, column })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      setCursor((c) => Math.min(c + 1, results.length - 1))
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      open(results[cursor])
    } else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="eva-files-qo-backdrop" onMouseDown={() => setQuickOpen(false)}>
      <div
        className="eva-files-qo"
        role="dialog"
        aria-label="Go to file"
        data-testid="quick-open"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="eva-files-qo-input">
          <IconSearch size={14} stroke={1.5} />
          <input
            ref={input}
            value={raw}
            placeholder="Go to file (add :line to jump)"
            spellCheck={false}
            aria-label="File name"
            aria-controls="eva-files-qo-list"
            onChange={(e) => setRaw(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setQuickOpen(false)}
          />
        </div>
        <div className="eva-files-qo-list" id="eva-files-qo-list" role="listbox" ref={listRef}>
          {files === null ? (
            <div className="eva-files-qo-note">Indexing files</div>
          ) : results.length === 0 ? (
            <div className="eva-files-qo-note">No files match.</div>
          ) : (
            results.map((r, i) => (
              <Item key={r.path} r={r} active={i === cursor} onOpen={() => open(r)} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
