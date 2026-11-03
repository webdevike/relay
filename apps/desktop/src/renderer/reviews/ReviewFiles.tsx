import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, SegmentedControl, TextInput } from '@mantine/core'
import { IconChevronDown, IconChevronRight, IconSearch } from '@tabler/icons-react'
import type { ReviewPr } from '@evaos/contract'
import { DiffView } from './DiffView'
import { parseDiff, splitPath } from './diff'

type Filter = 'all' | 'unviewed' | 'viewed'

const CHANGE_LABEL: Record<string, string> = {
  ADDED: 'added',
  DELETED: 'deleted',
  RENAMED: 'renamed',
}

/** Files: a flat file rail (filter, Viewed boxes) beside every file's diff, split by default. */
export function ReviewFiles({
  pr,
  viewed,
  onViewed,
  focus,
}: {
  pr: ReviewPr
  viewed: ReadonlySet<string>
  onViewed: (path: string, on: boolean) => void
  /** A path to scroll to (from the Guide's View in diff). */
  focus: string | null
}) {
  const diffs = useMemo(() => new Map(parseDiff(pr.diff).map((f) => [f.path, f])), [pr.diff])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [mode, setMode] = useState<'split' | 'unified'>('split')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [active, setActive] = useState<string | null>(focus)
  const scroller = useRef<HTMLDivElement>(null)

  const files = pr.files.filter(
    (f) =>
      f.path.toLowerCase().includes(query.toLowerCase()) &&
      (filter === 'all' || (filter === 'viewed') === viewed.has(f.path)),
  )

  const jump = (path: string): void => {
    setActive(path)
    scroller.current
      ?.querySelector(`[data-file="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: 'start' })
  }
  useEffect(() => {
    if (focus) jump(focus)
  }, [focus])

  return (
    <div className="eva-rv-files" data-testid="review-files">
      <div className="eva-rv-files-bar">
        <TextInput
          size="xs"
          leftSection={<IconSearch size={13} />}
          placeholder="Filter files by path"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          className="eva-rv-files-filter"
        />
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as Filter)}
          data={[
            { value: 'all', label: 'All' },
            { value: 'unviewed', label: 'Unviewed' },
            { value: 'viewed', label: 'Viewed' },
          ]}
        />
        <span className="eva-rv-spacer" />
        <span className="eva-rv-dim">
          {pr.files.length} files · {pr.files.filter((f) => viewed.has(f.path)).length} /{' '}
          {pr.files.length} viewed
        </span>
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as 'split' | 'unified')}
          data={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]}
          data-testid="review-diff-mode"
        />
      </div>
      <div className="eva-rv-files-body">
        <div className="eva-rv-filelist" role="list">
          {files.map((f) => {
            const { name } = splitPath(f.path)
            return (
              <div
                key={f.path}
                role="listitem"
                className="eva-rv-fileitem"
                data-active={active === f.path || undefined}
                title={f.path}
                onClick={() => jump(f.path)}
              >
                <Checkbox
                  size="xs"
                  checked={viewed.has(f.path)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onViewed(f.path, e.currentTarget.checked)}
                  aria-label={`Viewed ${f.path}`}
                />
                <span className="eva-rv-fileitem-name">{name}</span>
                <span className="eva-rv-add">+{f.additions}</span>
                <span className="eva-rv-del">-{f.deletions}</span>
              </div>
            )
          })}
        </div>
        <div className="eva-rv-filediffs" ref={scroller}>
          {files.map((f) => {
            const d = diffs.get(f.path)
            const { dir, name } = splitPath(f.path)
            const open = !collapsed.has(f.path) && !viewed.has(f.path)
            return (
              <section key={f.path} className="eva-rv-filecard" data-file={f.path}>
                <header className="eva-rv-filecard-head">
                  <button
                    type="button"
                    className="eva-rv-iconbtn"
                    aria-label={open ? 'Collapse' : 'Expand'}
                    onClick={() => {
                      const next = new Set(collapsed)
                      if (open) next.add(f.path)
                      else next.delete(f.path)
                      setCollapsed(next)
                    }}
                  >
                    {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  </button>
                  <span className="eva-rv-path">
                    <span className="eva-rv-dim">{dir}</span>
                    {name}
                  </span>
                  <span className="eva-rv-spacer" />
                  {CHANGE_LABEL[f.change] ? (
                    <span className="eva-rv-pill" data-tone="green">
                      {CHANGE_LABEL[f.change]}
                    </span>
                  ) : null}
                  <span className="eva-rv-add">+{f.additions}</span>
                  <span className="eva-rv-del">-{f.deletions}</span>
                  <Checkbox
                    size="xs"
                    label="Viewed"
                    checked={viewed.has(f.path)}
                    onChange={(e) => onViewed(f.path, e.currentTarget.checked)}
                  />
                </header>
                {open ? (
                  d && d.hunks.length > 0 ? (
                    <DiffView hunks={d.hunks} mode={mode} path={f.path} />
                  ) : (
                    <div className="eva-rv-empty">
                      {d?.binary ? 'Binary file' : 'No text changes to show'}
                    </div>
                  )
                ) : null}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
