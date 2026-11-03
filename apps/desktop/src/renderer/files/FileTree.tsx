import { memo, useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react'
import { IconChevronRight, IconLock } from '@tabler/icons-react'
import { VList, type VListHandle } from 'virtua'
import type { FileEntry } from '@evaos/contract'
import { FileIcon } from './FileIcon'
import {
  filesStore,
  openFile,
  revealInTree,
  select,
  setExpanded,
  useSpace,
  type Workspace,
} from './files-store'
import { Decorator, parentOf, visibleRows, type TreeRow } from './tree-model'

const NO_CHILDREN: Workspace['children'] = {}
const NO_EXPANDED: Set<string> = new Set()

const GIT_LABEL: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  U: 'Untracked',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Conflict',
}

const rowId = (path: string): string => `eva-files-row-${encodeURIComponent(path)}`

const Row = memo(function Row({
  row,
  selected,
  active,
  onPick,
}: {
  row: TreeRow
  selected: boolean
  active: boolean
  onPick: (entry: FileEntry, pin: boolean) => void
}) {
  const { entry, depth, expanded, decoration, ignored } = row
  const dir = entry.kind === 'dir'
  const code = decoration?.code
  return (
    <div
      id={rowId(entry.path)}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={dir ? expanded : undefined}
      aria-selected={selected}
      className="eva-files-row"
      data-selected={selected || undefined}
      data-active={active || undefined}
      data-git={code}
      data-ignored={ignored || undefined}
      data-locked={entry.locked || undefined}
      data-testid="files-row"
      data-path={entry.path}
      title={entry.path}
      onClick={() => onPick(entry, false)}
      onDoubleClick={() => onPick(entry, true)}
    >
      {depth > 0 ? (
        <span className="eva-files-guides">
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="eva-files-guide" />
          ))}
        </span>
      ) : null}
      <span className="eva-files-twist" data-open={expanded || undefined}>
        {dir ? <IconChevronRight size={14} stroke={1.75} /> : null}
      </span>
      <FileIcon name={entry.name} kind={entry.kind} expanded={expanded} />
      <span className="eva-files-name">{entry.name}</span>
      {entry.locked ? <IconLock size={12} stroke={1.5} className="eva-files-lock" /> : null}
      {code ? (
        decoration.inherited ? (
          <span className="eva-files-git-dot" aria-label={`Contains ${GIT_LABEL[code]} files`} />
        ) : (
          <span className="eva-files-git" aria-label={GIT_LABEL[code]}>
            {code}
          </span>
        )
      ) : null}
    </div>
  )
})

/** The explorer: lazy folders, Material icons, git colors, arrow-key navigation. */
export function FileTree({ root }: { root: string }) {
  const list = useRef<VListHandle>(null)
  const children = useSpace((w) => w.children, NO_CHILDREN)
  const expanded = useSpace((w) => w.expanded, NO_EXPANDED)
  const git = useSpace((w) => w.git, null)
  const showIgnored = useSpace((w) => w.showIgnored, false)
  const selected = useSpace((w) => w.selected, null)
  const active = useSpace((w) => w.active, null)
  const decorator = useMemo(() => new Decorator(git), [git])
  const rows = useMemo(
    () => visibleRows(children, expanded, decorator, showIgnored),
    [children, expanded, decorator, showIgnored],
  )
  const index = rows.findIndex((r) => r.entry.path === selected)

  // Reveal the active file, like VS Code's explorer.autoReveal.
  useEffect(() => {
    if (active) revealInTree(root, active)
  }, [root, active])

  useEffect(() => {
    if (index >= 0) list.current?.scrollToIndex(index, { align: 'nearest' })
  }, [index])

  // Stable, so memoized rows skip re-rendering while the tree state changes elsewhere.
  const pick = useCallback(
    (entry: FileEntry, pin: boolean): void => {
      select(root, entry.path)
      if (entry.locked) return
      if (entry.kind === 'dir') {
        const open = filesStore.getState().spaces[root]?.expanded.has(entry.path) ?? false
        if (!pin) setExpanded(root, entry.path, !open)
      } else openFile(root, entry.path, { pin })
    },
    [root],
  )

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const row = index >= 0 ? rows[index] : undefined
    const move = (i: number): void => {
      const next = rows[Math.min(Math.max(i, 0), rows.length - 1)]
      if (next) select(root, next.entry.path)
    }
    const dir = row?.entry.kind === 'dir'
    switch (e.key) {
      case 'ArrowDown':
        move(index + 1)
        break
      case 'ArrowUp':
        move(index < 0 ? rows.length - 1 : index - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(rows.length - 1)
        break
      case 'PageDown':
        move(index + 15)
        break
      case 'PageUp':
        move(index - 15)
        break
      case 'ArrowRight':
        if (!row || !dir || row.entry.locked) return
        if (!row.expanded) setExpanded(root, row.entry.path, true)
        else move(index + 1)
        break
      case 'ArrowLeft': {
        if (!row) return
        if (dir && row.expanded) setExpanded(root, row.entry.path, false)
        else {
          const parent = parentOf(row.entry.path)
          if (parent !== '') select(root, parent)
        }
        break
      }
      case 'Enter':
        if (!row) return
        pick(row.entry, true)
        break
      case ' ':
        if (!row || row.entry.locked) return
        if (dir) setExpanded(root, row.entry.path, !row.expanded)
        else openFile(root, row.entry.path, { pin: false })
        // Keep the keyboard in the tree while previewing.
        queueMicrotask(() =>
          document
            .getElementById(rowId(row.entry.path))
            ?.closest<HTMLElement>('[role=tree]')
            ?.focus(),
        )
        break
      default:
        return
    }
    e.preventDefault()
  }

  const loading = children[''] === undefined
  if (loading) return <div className="eva-files-empty">Loading files</div>
  if (rows.length === 0) return <div className="eva-files-empty">This folder is empty.</div>

  return (
    <div
      className="eva-files-tree"
      role="tree"
      tabIndex={0}
      aria-label="Files"
      aria-activedescendant={selected ? rowId(selected) : undefined}
      data-testid="files-tree"
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (index < 0 && rows[0])
          select(root, filesStore.getState().spaces[root]?.active ?? rows[0].entry.path)
      }}
    >
      <VList ref={list} style={{ height: '100%' }} itemSize={22}>
        {rows.map((row) => (
          <Row
            key={row.entry.path}
            row={row}
            selected={row.entry.path === selected}
            active={row.entry.path === active}
            onPick={pick}
          />
        ))}
      </VList>
    </div>
  )
}
