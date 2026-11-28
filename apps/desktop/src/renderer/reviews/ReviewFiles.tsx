import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, SegmentedControl, TextInput } from '@mantine/core'
import {
  IconChevronDown,
  IconChevronRight,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconSearch,
} from '@tabler/icons-react'
import type { ReviewPr } from '@evaos/contract'
import { DiffView } from './DiffView'
import { parseDiff, splitPath, type DiffFile } from '@relay/protocol/unified-diff'
import { parseOneOf, usePref } from '../ui-prefs'
import { buildFileTree, treeOrder, visibleFiles, type FileFilter } from './file-tree'
import { FileTree, useFileRail } from './FileTree'
import { useInlineThreads, type InlineThreads } from './ReviewThreads'
import './diff-tree.css'

type DiffMode = 'split' | 'unified'
const parseDiffMode = parseOneOf<DiffMode>(['split', 'unified'])

const CHANGE_LABEL: Record<string, string> = {
  ADDED: 'added',
  DELETED: 'deleted',
  RENAMED: 'renamed',
}

type PrFile = ReviewPr['files'][number]

function FileCard({
  f,
  d,
  mode,
  viewed,
  onViewed,
  open,
  onToggle,
  threads,
}: {
  f: PrFile
  d: DiffFile | undefined
  mode: DiffMode
  viewed: boolean
  onViewed: (path: string, on: boolean) => void
  open: boolean
  onToggle: () => void
  threads: InlineThreads
}) {
  const { dir, name } = splitPath(f.path)
  return (
    <section className="eva-rv-filecard" data-file={f.path}>
      <header className="eva-rv-filecard-head">
        <button
          type="button"
          className="eva-rv-iconbtn"
          aria-label={open ? 'Collapse' : 'Expand'}
          onClick={onToggle}
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
          checked={viewed}
          onChange={(e) => onViewed(f.path, e.currentTarget.checked)}
        />
      </header>
      {open ? <FileBody f={f} d={d} mode={mode} threads={threads} /> : null}
    </section>
  )
}

function FileBody({
  f,
  d,
  mode,
  threads,
}: {
  f: PrFile
  d: DiffFile | undefined
  mode: DiffMode
  threads: InlineThreads
}) {
  if (!d || d.hunks.length === 0)
    return (
      <div className="eva-rv-empty">{d?.binary ? 'Binary file' : 'No text changes to show'}</div>
    )
  return (
    <>
      {threads.unplaced(f.path, d.hunks)}
      <DiffView
        hunks={d.hunks}
        mode={mode}
        path={f.path}
        annotate={threads.annotate(f.path)}
        onComment={threads.onComment(f.path)}
      />
    </>
  )
}

/**
 * Files: a folder tree rail (filter, Viewed boxes, resizable, hideable) beside every file's diff,
 * split by default, with the PR's review threads on their lines. `compact` (a narrow side panel):
 * no rail, unified diffs, each file's card head still marks Viewed.
 */
export function ReviewFiles({
  pr,
  viewed,
  onViewed,
  focus,
  compact = false,
  onChanged,
}: {
  pr: ReviewPr
  viewed: ReadonlySet<string>
  onViewed: (path: string, on: boolean) => void
  /** A path to scroll to (from the Guide's View in diff); shown even when the filter hides it. */
  focus: string | null
  compact?: boolean
  /** A review comment was posted (the caller may read the PR again). */
  onChanged?: () => void
}) {
  const diffs = useMemo(() => new Map(parseDiff(pr.diff).map((f) => [f.path, f])), [pr.diff])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FileFilter>('all')
  const [savedMode, setMode] = usePref<DiffMode | null>('reviews.diffMode', null, parseDiffMode)
  const mode: DiffMode = savedMode ?? (compact ? 'unified' : 'split')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [active, setActive] = useState<string | null>(focus)
  const scroller = useRef<HTMLDivElement>(null)
  const rail = useFileRail()
  const threads = useInlineThreads(pr, onChanged)

  const shown = useMemo(
    () => visibleFiles(pr.files, { query, filter, viewed, reveal: focus }),
    [pr.files, query, filter, viewed, focus],
  )
  const nodes = useMemo(() => buildFileTree(shown, viewed), [shown, viewed])
  const byPath = new Map(shown.map((f) => [f.path, f]))
  const files = treeOrder(nodes).flatMap((p) => byPath.get(p) ?? [])

  const jump = (path: string): void => {
    setActive(path)
    scroller.current
      ?.querySelector(`[data-file="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: 'start' })
  }
  useEffect(() => {
    if (focus) jump(focus)
  }, [focus])

  const toggle = (path: string, open: boolean): void => {
    const next = new Set(collapsed)
    if (open) next.add(path)
    else next.delete(path)
    setCollapsed(next)
  }

  return (
    <div className="eva-rv-files" data-compact={compact || undefined} data-testid="review-files">
      <div className="eva-rv-files-bar">
        {compact ? null : (
          <button
            type="button"
            className="eva-rv-iconbtn"
            aria-label={rail.open ? 'Hide files' : 'Show files'}
            aria-pressed={rail.open}
            onClick={() => rail.setOpen(!rail.open)}
            data-testid="review-rail-toggle"
          >
            {rail.open ? (
              <IconLayoutSidebarLeftCollapse size={15} />
            ) : (
              <IconLayoutSidebarLeftExpand size={15} />
            )}
          </button>
        )}
        <TextInput
          size="xs"
          leftSection={<IconSearch size={13} />}
          placeholder="Filter files by path"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          className="eva-rv-files-filter"
          data-testid="review-files-filter"
        />
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={(v) => setFilter(v as FileFilter)}
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
          onChange={(v) => setMode(v as DiffMode)}
          data={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]}
          data-testid="review-diff-mode"
        />
      </div>
      <div className="eva-rv-files-body">
        {compact ? null : (
          <FileTree
            nodes={nodes}
            viewed={viewed}
            onViewed={onViewed}
            active={active}
            reveal={focus}
            onOpen={jump}
          />
        )}
        <div className="eva-rv-filediffs" ref={scroller}>
          {files.map((f) => {
            const open = !collapsed.has(f.path) && !viewed.has(f.path)
            return (
              <FileCard
                key={f.path}
                f={f}
                d={diffs.get(f.path)}
                mode={mode}
                viewed={viewed.has(f.path)}
                onViewed={onViewed}
                open={open}
                onToggle={() => toggle(f.path, open)}
                threads={threads}
              />
            )
          })}
        </div>
      </div>
      {threads.overlay}
    </div>
  )
}
