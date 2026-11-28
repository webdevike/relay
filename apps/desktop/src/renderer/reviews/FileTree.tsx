// The Diff tab's file rail: the PR's files as a folder tree (Mantine Tree), type icons, +/- in fixed
// columns, Viewed boxes, click or Enter to jump to a file's diff, arrow keys to move. The rail's
// width (200-480 px, pointer or arrow keys on its edge) and whether it shows are saved prefs.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Checkbox, Tree, useTree, type RenderTreeNodePayload } from '@mantine/core'
import {
  IconBrandPython,
  IconBrandRust,
  IconFile,
  IconFileCode,
  IconFileText,
  IconFileTypeCss,
  IconFileTypeHtml,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypeSql,
  IconFileTypeTs,
  IconFileTypeTsx,
  IconFolder,
  IconFolderOpen,
  IconJson,
  IconMarkdown,
  IconPhoto,
  IconSettings,
} from '@tabler/icons-react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { bindPref, parseBool, parseNumber } from '../ui-prefs'
import {
  RAIL_MAX,
  RAIL_MIN,
  RAIL_STEP,
  ancestorsOf,
  clampRail,
  folderValues,
  type FileFacts,
  type FileTreeNode,
} from './file-tree'
import './diff-tree.css'

interface RailState {
  width: number
  open: boolean
}

const railStore = createStore<RailState>(() => ({ width: 260, open: true }))
bindPref(railStore, 'reviews.fileRail.width', {
  select: (s) => s.width,
  apply: (width) => ({ width }),
  parse: parseNumber(RAIL_MIN, RAIL_MAX),
})
bindPref(railStore, 'reviews.fileRail.open', {
  select: (s) => s.open,
  apply: (open) => ({ open }),
  parse: parseBool,
})

export function useFileRail(): RailState & {
  setWidth: (w: number) => void
  setOpen: (open: boolean) => void
} {
  const s = useStore(railStore)
  return {
    ...s,
    setWidth: (w) => railStore.setState({ width: clampRail(w) }),
    setOpen: (open) => railStore.setState({ open }),
  }
}

type Icon = typeof IconFile
const ICONS: Record<string, Icon> = {
  ts: IconFileTypeTs,
  mts: IconFileTypeTs,
  cts: IconFileTypeTs,
  tsx: IconFileTypeTsx,
  js: IconFileTypeJs,
  mjs: IconFileTypeJs,
  cjs: IconFileTypeJs,
  jsx: IconFileTypeJsx,
  json: IconJson,
  jsonc: IconJson,
  md: IconMarkdown,
  mdx: IconMarkdown,
  css: IconFileTypeCss,
  scss: IconFileTypeCss,
  html: IconFileTypeHtml,
  sql: IconFileTypeSql,
  py: IconBrandPython,
  rs: IconBrandRust,
  png: IconPhoto,
  jpg: IconPhoto,
  jpeg: IconPhoto,
  gif: IconPhoto,
  svg: IconPhoto,
  webp: IconPhoto,
  txt: IconFileText,
  yml: IconSettings,
  yaml: IconSettings,
  toml: IconSettings,
  nix: IconSettings,
  sh: IconFileCode,
  go: IconFileCode,
  swift: IconFileCode,
  kt: IconFileCode,
}

function iconOf(facts: FileFacts, expanded: boolean): Icon {
  if (facts.kind === 'dir') return expanded ? IconFolderOpen : IconFolder
  const ext = /\.([\w]+)$/.exec(facts.path)?.[1]?.toLowerCase() ?? ''
  return ICONS[ext] ?? IconFile
}

interface RowOpts {
  viewed: ReadonlySet<string>
  onViewed: (path: string, on: boolean) => void
  onOpen: (path: string) => void
}

function Row({
  node,
  expanded,
  selected,
  elementProps,
  opts,
}: RenderTreeNodePayload & { opts: RowOpts }) {
  const facts = (node as FileTreeNode).nodeProps
  const Glyph = iconOf(facts, expanded)
  const file = facts.kind === 'file'
  const seen = file ? opts.viewed.has(facts.path) : facts.viewed === facts.files
  return (
    <div
      {...elementProps}
      onClick={(e) => {
        elementProps.onClick(e)
        if (file) opts.onOpen(facts.path)
      }}
      className={`${elementProps.className} eva-rv-tree-row`}
      data-kind={facts.kind}
      data-change={facts.change ?? undefined}
      data-viewed={seen || undefined}
      data-active={selected || undefined}
      data-path={facts.path}
      title={facts.path}
      data-testid="review-tree-row"
    >
      <Glyph size={14} className="eva-rv-tree-icon" aria-hidden />
      <span className="eva-rv-tree-label">{String(node.label)}</span>
      <span className="eva-rv-tree-add">+{facts.additions}</span>
      <span className="eva-rv-tree-del">-{facts.deletions}</span>
      <span className="eva-rv-tree-check">
        {file ? (
          <Checkbox
            size="xs"
            checked={seen}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => opts.onViewed(facts.path, e.currentTarget.checked)}
            aria-label={`Viewed ${facts.path}`}
            tabIndex={-1}
          />
        ) : null}
      </span>
    </div>
  )
}

/** The rail's edge: drag it, or focus it and use the arrow keys (Home/End for the bounds). */
function Resizer({ width, setWidth }: { width: number; setWidth: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number } | null>(null)
  const KEYS: Record<string, number> = {
    ArrowLeft: width - RAIL_STEP,
    ArrowRight: width + RAIL_STEP,
    Home: RAIL_MIN,
    End: RAIL_MAX,
  }
  return (
    <div
      className="eva-rv-ftree-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize files"
      aria-valuemin={RAIL_MIN}
      aria-valuemax={RAIL_MAX}
      aria-valuenow={width}
      tabIndex={0}
      data-testid="review-rail-resize"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width }
      }}
      onPointerMove={(e) => {
        if (drag.current) setWidth(drag.current.w + e.clientX - drag.current.x)
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={(e) => {
        const next = KEYS[e.key]
        if (next === undefined) return
        e.preventDefault()
        setWidth(next)
      }}
    />
  )
}

/**
 * The file tree beside the diffs. `active` is the file shown (selected); `reveal` a file the Guide
 * pointed at: its folders open, it scrolls into view and takes focus.
 */
export function FileTree({
  nodes,
  viewed,
  onViewed,
  active,
  reveal,
  onOpen,
}: {
  nodes: FileTreeNode[]
  viewed: ReadonlySet<string>
  onViewed: (path: string, on: boolean) => void
  active: string | null
  reveal: string | null
  onOpen: (path: string) => void
}) {
  const rail = useFileRail()
  const box = useRef<HTMLDivElement>(null)
  // Folders open unless Isaac closed them, so a filter's new folders show open.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const expandedState = useMemo(
    () => Object.fromEntries(folderValues(nodes).map((v) => [v, !closed.has(v)])),
    [nodes, closed],
  )
  const tree = useTree({
    expandedState,
    onExpandedStateChange: (s) =>
      setClosed(new Set(Object.entries(s).flatMap(([v, open]) => (open ? [] : [v])))),
    selectedState: active ? [active] : [],
  })
  const nodesNow = useRef(nodes)
  nodesNow.current = nodes
  useEffect(() => {
    if (!reveal) return
    setClosed((c) => {
      const up = ancestorsOf(nodesNow.current, reveal).filter((v) => c.has(v))
      if (up.length === 0) return c
      const next = new Set(c)
      for (const v of up) next.delete(v)
      return next
    })
    requestAnimationFrame(() => {
      const row = box.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(reveal)}"]`)
      row?.scrollIntoView({ block: 'nearest' })
      row?.closest<HTMLElement>('[role=treeitem]')?.focus({ preventScroll: true })
    })
  }, [reveal])

  const opts: RowOpts = { viewed, onViewed, onOpen }
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    if (e.key !== 'Enter') return
    const item = (e.target as HTMLElement).closest<HTMLElement>('[role=treeitem]')
    const path = item?.querySelector<HTMLElement>('[data-kind=file]')?.dataset.path
    if (path && item?.dataset.value === path) onOpen(path)
  }

  if (!rail.open) return null
  return (
    <div
      className="eva-rv-ftree"
      style={{ width: rail.width }}
      ref={box}
      data-testid="review-file-tree"
    >
      <div className="eva-rv-ftree-scroll">
        {nodes.length === 0 ? (
          <div className="eva-rv-dim eva-rv-small eva-rv-ftree-empty">No files match</div>
        ) : (
          <Tree
            data={nodes}
            tree={tree}
            levelOffset="sm"
            expandOnClick
            onKeyDown={onKeyDown}
            renderNode={(p) => <Row {...p} opts={opts} />}
          />
        )}
      </div>
      <Resizer width={rail.width} setWidth={rail.setWidth} />
    </div>
  )
}
