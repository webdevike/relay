/**
 * One open board on React Flow (native canvas_view.rs): loads the file, places what has no
 * position, autosaves edits a second after they settle, reloads outside edits (never during a
 * drag) and keeps undo history. Pointer and keys: drag empty space or scroll to pan, ⌘-scroll or
 * pinch zooms, ⇧-drag box-selects, ⌘A selects all, Escape clears, Backspace/Delete removes,
 * ⌘Z / ⌘⇧Z undo and redo. Double-clicking an image opens it full window.
 */
import '@xyflow/react/dist/base.css'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { Button } from '@mantine/core'
import { IconSparkles } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { CanvasBoard as BoardFile, CanvasNode, CanvasViewport } from '@evaos/contract'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { invoke, on } from '../ipc'
import {
  FIT_PADDING,
  edgeId,
  edgePairs,
  effectiveLayout,
  layoutItems,
  nextNoteId,
  placeUnplaced,
  reloadPositions,
  roundHalfAway,
  visibleShare,
  titleOf,
} from './board-model'
import { onBoardOp } from './canvas-store'
import { liveRoomOn, liveStore } from './live/live-store'
import { CanvasEdge } from './CanvasEdge'
import { BoardContext, type BoardActions } from './context'
import { BoardControls, NodeActions, ToolBar, type Tool } from './chrome'
import { CanvasCard } from './cards/CanvasCard'
import { Lightbox } from './Lightbox'
import { boardImages } from './lightbox-model'
import {
  absolutePositions,
  toBoard,
  toFlowEdges,
  toFlowNodes,
  type BoardDoc,
  type CardNode,
  type LinkEdge,
} from './flow-model'
import { emptyHistory, record, redo, undo, type History, type Snapshot } from './history'
import { place, type Point, type Size } from './layout'

const NODE_TYPES = { card: CanvasCard }
const EDGE_TYPES = { link: CanvasEdge }

/** How long edits settle before the board saves. */
const SAVE_DELAY = 1000
/** How far a drawn size may drift from the one laid out before the board re-tidies, and how often. */
const SETTLE_SLACK = 8
const SETTLE_ROUNDS = 6
/** A new note's size in flow units. */
const NOTE_SIZE: Size = [220, 120]

type SaveState = 'saved' | 'unsaved' | 'saving' | { error: string }

/** What the last automatic layout used and produced, while nobody has moved anything. */
interface AutoPlaced {
  sizes: Map<string, Size>
  positions: Map<string, Point>
  rounds: number
  /**
   * The drawn sizes matched the layout at the last check. Until then the board doesn't save, so
   * leaving early keeps the file unplaced and the next open lays it out again.
   */
  quiet: boolean
}

function measuredSizes(nodes: readonly CardNode[]): Map<string, Size> {
  const out = new Map<string, Size>()
  for (const n of nodes) {
    const w = n.measured?.width
    const h = n.measured?.height
    if (w !== undefined && h !== undefined) out.set(n.id, [w, h])
  }
  return out
}

/** Specs in file order with the frame sizes a layout chose written in, rounded like native. */
function withFrameSizes(
  specs: readonly CanvasNode[],
  sizes: ReadonlyMap<string, Size>,
): CanvasNode[] {
  return specs.map((s) => {
    const size = sizes.get(s.id)
    return size ? { ...s, w: roundHalfAway(size[0]), h: roundHalfAway(size[1]) } : s
  })
}

/** Rebuilt nodes keep what React Flow measured, so nothing flashes unmeasured. */
function keepMeasured(next: CardNode[], prev: readonly CardNode[]): CardNode[] {
  const old = new Map(prev.map((n) => [n.id, n]))
  return next.map((n) => {
    const m = old.get(n.id)?.measured
    return m ? { ...n, measured: m } : n
  })
}

function specsOf(nodes: readonly CardNode[]): CanvasNode[] {
  return [...nodes].sort((a, b) => a.data.rank - b.data.rank).map((n) => n.data.spec)
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function saveLabel(state: SaveState): string {
  return typeof state === 'object' ? `not saved: ${state.error}` : state
}

function Board({ slug }: { slug: string }) {
  const flow = useReactFlow<CardNode, LinkEdge>()
  const initialized = useNodesInitialized()
  const [nodes, setNodes] = useState<CardNode[]>([])
  const [edges, setEdges] = useState<LinkEdge[]>([])
  const [title, setTitle] = useState('')
  const [layout, setLayout] = useState<BoardFile['layout']>(undefined)
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [save, setSave] = useState<SaveState>('saved')
  const [tool, setTool] = useState<Tool>('select')
  const [locked, setLocked] = useState(false)
  const [history, setHistory] = useState<History<BoardDoc>>(emptyHistory)
  /** The image shown full window, if any. */
  const [lightboxId, setLightboxId] = useState<string | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  const docRef = useRef<BoardDoc>({ title: '', layout: undefined, nodes: [], edges: [] })
  docRef.current = { title, layout, nodes, edges }
  const historyRef = useRef(history)
  historyRef.current = history
  /** The board text last read or written, as `JSON.stringify` of the board. */
  const syncedRef = useRef('')
  const timerRef = useRef<number | undefined>(undefined)
  const draggingRef = useRef(false)
  const reloadPendingRef = useRef(false)
  const goneRef = useRef(false)
  const unmountedRef = useRef(false)
  const fitPendingRef = useRef(false)
  /** A saved viewport to check once the nodes are drawn: it may come from a wider window. */
  const checkViewRef = useRef(false)
  /** A viewport the board moved to on its own (a rescue fit on open); reaching it doesn't save. */
  const quietViewRef = useRef<CanvasViewport | null>(null)
  const autoRef = useRef<AutoPlaced | null>(null)

  const snapshot = useCallback((): Snapshot<BoardDoc> => {
    const doc = docRef.current
    return { key: JSON.stringify(toBoard(doc, null)), value: doc }
  }, [])

  /** Records the board before an action, as one undo step. */
  const remember = useCallback(() => {
    setHistory((h) => record(h, snapshot()))
  }, [snapshot])

  /**
   * The viewport a save writes: the file's own while the board sits where a rescue fit put it,
   * so opening a board never rewrites it; else where the board is.
   */
  const viewToSave = useCallback((): CanvasViewport => {
    const vp = flow.getViewport()
    const quiet = quietViewRef.current
    if (!quiet || quiet.x !== vp.x || quiet.y !== vp.y || quiet.zoom !== vp.zoom) return vp
    const synced = JSON.parse(syncedRef.current) as BoardFile
    return synced.viewport ?? vp
  }, [flow])

  const saveNow = useCallback(async () => {
    timerRef.current = undefined
    if (goneRef.current || !syncedRef.current) return
    // A live room on this board writes the file itself; the room's edits come back as a reload.
    if (liveRoomOn(liveStore.getState().data, slug)) return
    const settling = autoRef.current !== null && !autoRef.current.quiet
    if (draggingRef.current || settling) {
      if (!unmountedRef.current)
        timerRef.current = window.setTimeout(() => void saveNow(), SAVE_DELAY)
      return
    }
    const board = toBoard(docRef.current, viewToSave())
    const key = JSON.stringify(board)
    if (key === syncedRef.current) {
      setSave('saved')
      return
    }
    setSave('saving')
    const r = await invoke('canvas.save', { slug, board })
    if (goneRef.current) return
    if (r.ok) {
      syncedRef.current = key
      // A newer edit keeps the board unsaved until its own save.
      if (timerRef.current === undefined) setSave('saved')
    } else setSave({ error: r.error.message })
  }, [viewToSave, slug])

  const scheduleSave = useCallback(() => {
    if (goneRef.current) return
    clearTimeout(timerRef.current)
    setSave('unsaved')
    timerRef.current = window.setTimeout(() => void saveNow(), SAVE_DELAY)
  }, [saveNow])

  /** Saves (after the usual delay) only when the board no longer matches its file. */
  const saveIfChanged = useCallback(() => {
    if (JSON.stringify(toBoard(docRef.current, viewToSave())) !== syncedRef.current) scheduleSave()
  }, [viewToSave, scheduleSave])

  /**
   * Puts a file's contents on the board, keeping selection and where nodes the file leaves
   * unplaced already sit (a reload), and placing the rest.
   */
  const apply = useCallback(
    (file: BoardFile) => {
      const prev = docRef.current.nodes
      const current = absolutePositions(prev)
      const measured = measuredSizes(prev)
      const selected = new Set(prev.filter((n) => n.selected).map((n) => n.id))
      const placed = reloadPositions(file.nodes, current)
      const at = new Map<string, Point>()
      const unplaced: string[] = []
      for (const [id, p] of placed) {
        if (p) at.set(id, p)
        else unplaced.push(id)
      }
      const fileLayout = effectiveLayout(file.layout, file.nodes, file.edges.length > 0)
      const result = placeUnplaced({
        layout: fileLayout,
        nodes: file.nodes,
        edges: file.edges,
        placed: at,
        measured,
        unplaced,
      })
      for (const [id, p] of result.positions) at.set(id, p)
      const specs = withFrameSizes(file.nodes, result.frameSizes)
      const next = keepMeasured(toFlowNodes(specs, at, selected), prev)
      autoRef.current =
        file.nodes.length > 0 && unplaced.length === file.nodes.length
          ? {
              sizes: new Map(layoutItems(specs, measured).map((i) => [i.id, [i.w, i.h] as Size])),
              positions: result.positions,
              rounds: 0,
              quiet: false,
            }
          : null
      const nextEdges = toFlowEdges(file.edges)
      const nextTitle = file.title === '' ? slug : file.title
      setNodes(next)
      setEdges(nextEdges)
      setTitle(nextTitle)
      setLayout(file.layout)
      docRef.current = { title: nextTitle, layout: file.layout, nodes: next, edges: nextEdges }
    },
    [slug],
  )

  // Load on open.
  useEffect(() => {
    let live = true
    goneRef.current = false
    void invoke('canvas.load', { slug }).then((r) => {
      if (!live) return
      if (!r.ok) {
        setFailure(r.error.code === 'not-found' ? 'This board is gone.' : r.error.message)
        return
      }
      syncedRef.current = JSON.stringify(r.value.board)
      apply(r.value.board)
      setLoaded(true)
      // The file's viewport, else a fit once the nodes are drawn; placing nodes or fitting
      // changes the file, which then saves like any edit.
      const viewport = r.value.board.viewport
      if (viewport) {
        checkViewRef.current = true
        void flow.setViewport(viewport).then(saveIfChanged)
      } else fitPendingRef.current = true
    })
    return () => {
      live = false
    }
  }, [slug, apply, flow, saveIfChanged])

  // Leaving the board saves what is pending.
  useEffect(
    () => () => {
      unmountedRef.current = true
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        void saveNow()
      }
    },
    [saveNow],
  )

  const reload = useCallback(async () => {
    reloadPendingRef.current = false
    const r = await invoke('canvas.load', { slug })
    if (goneRef.current) return
    if (!r.ok) {
      if (r.error.code === 'not-found') {
        goneRef.current = true
        setFailure('This board is gone.')
      } else setSave({ error: `file not loaded: ${r.error.message}` })
      return
    }
    const key = JSON.stringify(r.value.board)
    if (key === syncedRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    syncedRef.current = key
    apply(r.value.board)
    setSave('saved')
    saveIfChanged()
  }, [apply, saveIfChanged, slug])

  // An outside edit reloads the board, after any drag in progress.
  useEffect(
    () =>
      on('canvas.changed', (e) => {
        if (e.slug !== slug || !syncedRef.current) return
        if (draggingRef.current) reloadPendingRef.current = true
        else void reload()
      }),
    [reload, slug],
  )

  // Renames and deletes from the sidebar.
  useEffect(
    () =>
      onBoardOp((op) => {
        if (op.slug !== slug) return
        if (op.kind === 'deleted') {
          goneRef.current = true
          clearTimeout(timerRef.current)
          timerRef.current = undefined
          setFailure('This board is gone.')
          return
        }
        setTitle(op.title)
        if (syncedRef.current) {
          const synced = JSON.parse(syncedRef.current) as BoardFile
          syncedRef.current = JSON.stringify({ ...synced, title: op.title })
        }
      }),
    [slug],
  )

  // Fit once the first nodes are drawn when the file has no viewport. A saved viewport that shows
  // under a quarter of the board (saved in a wider window) is fitted too, without saving.
  useEffect(() => {
    if (!initialized) return
    if (checkViewRef.current) {
      checkViewRef.current = false
      const r = wrapRef.current?.getBoundingClientRect()
      const bounds = flow.getNodesBounds(flow.getNodes())
      if (r && visibleShare(bounds, flow.getViewport(), r.width, r.height) < 0.25) {
        void flow.fitView({ padding: FIT_PADDING }).then(() => {
          quietViewRef.current = flow.getViewport()
        })
      }
    }
    if (!fitPendingRef.current) return
    fitPendingRef.current = false
    void flow.fitView({ padding: FIT_PADDING }).then(() => scheduleSave())
  }, [initialized, flow, scheduleSave])

  // While every node sits where the layout put it, lay out again once drawn sizes differ
  // from the ones used (images arriving). Stops at the first move.
  useEffect(() => {
    const auto = autoRef.current
    if (!auto || !initialized) return
    const t = setTimeout(() => {
      const doc = docRef.current
      const abs = absolutePositions(doc.nodes)
      const moved = doc.nodes.some((n) => {
        const was = auto.positions.get(n.id)
        const now = abs.get(n.id)
        return !was || !now || Math.abs(was[0] - now[0]) > 0.5 || Math.abs(was[1] - now[1]) > 0.5
      })
      if (moved) {
        autoRef.current = null
        return
      }
      if (doc.nodes.some((n) => n.measured?.width === undefined)) return
      const specs = specsOf(doc.nodes)
      const items = layoutItems(specs, measuredSizes(doc.nodes))
      const changed = items.some((i) => {
        const s = auto.sizes.get(i.id)
        return !s || Math.abs(s[0] - i.w) > SETTLE_SLACK || Math.abs(s[1] - i.h) > SETTLE_SLACK
      })
      if (!changed || auto.rounds >= SETTLE_ROUNDS) {
        if (!auto.quiet) {
          auto.quiet = true
          saveIfChanged()
        }
        return
      }
      const fileLayout = effectiveLayout(doc.layout, specs, doc.edges.length > 0)
      const placement = place(fileLayout, items, edgePairs(doc.edges))
      const sized = withFrameSizes(specs, placement.frameSizes)
      const selected = new Set(doc.nodes.filter((n) => n.selected).map((n) => n.id))
      const next = keepMeasured(toFlowNodes(sized, placement.positions, selected), doc.nodes)
      autoRef.current = {
        sizes: new Map(items.map((i) => [i.id, [i.w, i.h] as Size])),
        positions: placement.positions,
        rounds: auto.rounds + 1,
        quiet: false,
      }
      setNodes(next)
      fitPendingRef.current = true
      requestAnimationFrame(() => {
        fitPendingRef.current = false
        void flow.fitView({ padding: FIT_PADDING }).then(() => scheduleSave())
      })
    }, 250)
    return () => clearTimeout(t)
  }, [nodes, initialized, flow, scheduleSave, saveIfChanged])

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      // Removing goes through deleteSelected, which keeps children of a deleted frame.
      const kept = changes.filter((c) => c.type !== 'remove')
      setNodes((ns) => applyNodeChanges(kept, ns))
      if (
        kept.some(
          (c) =>
            (c.type === 'position' && !c.dragging) || (c.type === 'dimensions' && c.setAttributes),
        )
      )
        scheduleSave()
    },
    [scheduleSave],
  )

  const onEdgesChange = useCallback((changes: EdgeChange<LinkEdge>[]) => {
    setEdges((es) =>
      applyEdgeChanges(
        changes.filter((c) => c.type !== 'remove'),
        es,
      ),
    )
  }, [])

  const dragStart = useCallback(() => {
    draggingRef.current = true
    remember()
  }, [remember])

  const dragStop = useCallback(() => {
    draggingRef.current = false
    autoRef.current = null
    scheduleSave()
    if (reloadPendingRef.current) void reload()
  }, [reload, scheduleSave])

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return
      remember()
      setEdges((es) => [
        ...es,
        {
          id: edgeId(
            c.source,
            c.target,
            es.map((e) => e.id),
          ),
          source: c.source,
          target: c.target,
          sourceHandle: c.sourceHandle,
          targetHandle: c.targetHandle,
          type: 'link',
          data: {},
        },
      ])
      scheduleSave()
    },
    [remember, scheduleSave],
  )

  /** Removes `ids` and their edges; nodes in a removed frame stay where they are, unframed. */
  const removeNodes = useCallback(
    (ids: ReadonlySet<string>, edgeIds: ReadonlySet<string> = new Set()) => {
      if (ids.size === 0 && edgeIds.size === 0) return
      remember()
      const doc = docRef.current
      const abs = absolutePositions(doc.nodes)
      const kept: CardNode[] = doc.nodes
        .filter((n) => !ids.has(n.id))
        .map((n): CardNode => {
          if (n.parentId === undefined || !ids.has(n.parentId)) return n
          const [x, y] = abs.get(n.id) ?? [0, 0]
          const { parent: _parent, ...spec } = n.data.spec
          const { parentId: _p, expandParent: _e, ...rest } = n
          return { ...rest, position: { x, y }, data: { ...n.data, spec } }
        })
      const frames = new Set(kept.map((n) => n.parentId).filter((p) => p !== undefined))
      setNodes(
        kept.map((n) =>
          n.data.hasChildren === frames.has(n.id)
            ? n
            : { ...n, data: { ...n.data, hasChildren: frames.has(n.id) } },
        ),
      )
      setEdges(
        doc.edges.filter((e) => !edgeIds.has(e.id) && !ids.has(e.source) && !ids.has(e.target)),
      )
      scheduleSave()
    },
    [remember, scheduleSave],
  )

  const deleteSelected = useCallback(() => {
    const doc = docRef.current
    removeNodes(
      new Set(doc.nodes.filter((n) => n.selected).map((n) => n.id)),
      new Set(doc.edges.filter((e) => e.selected).map((e) => e.id)),
    )
  }, [removeNodes])

  /** Adds a selected note with its top left at `at`, linked from `from`, as one undo step. */
  const addNote = useCallback(
    (at: Point, noteTitle: string, from: string | null, skipUndo = false) => {
      if (!skipUndo) remember()
      const doc = docRef.current
      const id = nextNoteId(doc.nodes.map((n) => n.id))
      const rank = doc.nodes.reduce((m, n) => Math.max(m, n.data.rank), -1) + 1
      const note: CardNode = {
        id,
        type: 'card',
        position: { x: at[0], y: at[1] },
        data: { spec: { id, type: 'note', data: { title: noteTitle } }, rank, hasChildren: false },
        width: NOTE_SIZE[0],
        selected: true,
        zIndex: 0,
      }
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), note])
      if (from !== null) {
        setEdges((es) => [
          ...es,
          {
            id: edgeId(
              from,
              id,
              es.map((e) => e.id),
            ),
            source: from,
            target: id,
            type: 'link',
            data: {},
          },
        ])
      }
      autoRef.current = null
      scheduleSave()
      return id
    },
    [remember, scheduleSave],
  )

  const addNoteAtCenter = useCallback(() => {
    const r = wrapRef.current?.getBoundingClientRect()
    const center = r
      ? flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
      : { x: 0, y: 0 }
    addNote([center.x - NOTE_SIZE[0] / 2, center.y - NOTE_SIZE[1] / 2], 'New note', null)
  }, [addNote, flow])

  const addLinkedNote = useCallback(
    (id: string) => {
      const doc = docRef.current
      const node = doc.nodes.find((n) => n.id === id)
      const at = absolutePositions(doc.nodes).get(id)
      if (!node || !at) return
      const h = node.measured?.height ?? node.height ?? NOTE_SIZE[1]
      addNote([at[0], at[1] + h + 60], 'Note', id)
    },
    [addNote],
  )

  const highlightLinks = useCallback(
    (id: string) => {
      const touches = (e: LinkEdge): boolean => e.source === id || e.target === id
      const doc = docRef.current
      const touching = doc.edges.filter(touches)
      if (touching.length === 0) return
      const allOn = touching.every((e) => e.data?.tone === 'accent')
      remember()
      setEdges(
        doc.edges.map((e) => {
          if (!touches(e)) return e
          const { tone: _tone, ...data } = e.data ?? {}
          return { ...e, data: allOn ? data : { ...data, tone: 'accent' } }
        }),
      )
      scheduleSave()
    },
    [remember, scheduleSave],
  )

  const copyTitle = useCallback((id: string) => {
    const node = docRef.current.nodes.find((n) => n.id === id)
    if (node) void navigator.clipboard.writeText(titleOf(node.data.spec)).catch(() => {})
  }, [])

  const actions = useMemo<BoardActions>(
    () => ({
      slug,
      removeNode: (id) => removeNodes(new Set([id])),
      openImage: setLightboxId,
      acceptSuggestion: (id) => {
        const doc = docRef.current
        const node = doc.nodes.find((n) => n.id === id)
        const at = absolutePositions(doc.nodes).get(id)
        if (!node || !at) return
        const from = doc.edges.find((e) => e.target === id)?.source ?? null
        const noteTitle = titleOf(node.data.spec).replace(/^Eva suggests: /, '')
        removeNodes(new Set([id]))
        addNote(at, noteTitle, from, true)
      },
    }),
    [slug, removeNodes, addNote],
  )

  const restore = useCallback(
    (doc: BoardDoc) => {
      setNodes(keepMeasured(doc.nodes, docRef.current.nodes))
      setEdges(doc.edges)
      setTitle(doc.title)
      setLayout(doc.layout)
      autoRef.current = null
      scheduleSave()
    },
    [scheduleSave],
  )

  const doUndo = useCallback(() => {
    const r = undo(historyRef.current, snapshot())
    if (!r) return
    setHistory(r.history)
    restore(r.state)
  }, [restore, snapshot])

  const doRedo = useCallback(() => {
    const r = redo(historyRef.current, snapshot())
    if (!r) return
    setHistory(r.history)
    restore(r.state)
  }, [restore, snapshot])

  const tidy = useCallback(() => {
    remember()
    const doc = docRef.current
    const specs = specsOf(doc.nodes)
    const items = layoutItems(specs, measuredSizes(doc.nodes))
    const fileLayout = effectiveLayout(doc.layout, specs, doc.edges.length > 0)
    const placement = place(fileLayout, items, edgePairs(doc.edges))
    const sized = withFrameSizes(specs, placement.frameSizes)
    const selected = new Set(doc.nodes.filter((n) => n.selected).map((n) => n.id))
    setNodes(keepMeasured(toFlowNodes(sized, placement.positions, selected), doc.nodes))
    autoRef.current = null
    requestAnimationFrame(
      () => void flow.fitView({ padding: FIT_PADDING }).then(() => scheduleSave()),
    )
  }, [flow, remember, scheduleSave])

  const selectAll = useCallback(() => {
    setNodes((ns) => ns.map((n) => (n.selected ? n : { ...n, selected: true })))
  }, [])

  const hasSelection = nodes.some((n) => n.selected) || edges.some((e) => e.selected)
  useDismissable(
    DISMISS_PRIORITY.selection,
    () => {
      setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
      setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)))
    },
    hasSelection,
  )

  const onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement
    if (t.closest('input, textarea, [contenteditable=true]')) return
    const key = e.key.toLowerCase()
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !locked) {
      e.preventDefault()
      deleteSelected()
    } else if (e.metaKey && key === 'a') {
      e.preventDefault()
      selectAll()
    } else if (e.metaKey && key === 'z' && !locked) {
      e.preventDefault()
      if (e.shiftKey) doRedo()
      else doUndo()
    }
  }

  const selectedNodes = nodes.filter((n) => n.selected)
  const single = selectedNodes.length === 1 ? selectedNodes[0]! : null
  const specs = useMemo(() => nodes.map((n) => n.data.spec), [nodes])
  const images = useMemo(() => boardImages(specsOf(nodes)), [nodes])
  const shownLayout = effectiveLayout(layout, specs, edges.length > 0)
  const hand = tool === 'hand'

  if (failure !== null) {
    return (
      <div className="eva-cv-empty" data-testid="canvas-missing">
        {failure}
      </div>
    )
  }

  return (
    <BoardContext.Provider value={actions}>
      <div className="eva-cv-page" data-testid="canvas-board" data-slug={slug}>
        <header className="eva-cv-header">
          <h1 className="eva-cv-title" data-testid="canvas-title">
            {title}
          </h1>
          <span
            className="eva-cv-status-line"
            data-testid="canvas-status"
            data-error={typeof save === 'object' ? 'true' : undefined}
          >
            {loaded
              ? `${plural(nodes.length, 'node', 'nodes')} · ${plural(edges.length, 'edge', 'edges')} · ${saveLabel(save)}`
              : 'Loading'}
          </span>
          <Button
            variant="subtle"
            color="gray"
            size="compact-sm"
            className="eva-cv-tidy"
            data-testid="canvas-tidy"
            title="Lay the board out again"
            leftSection={<IconSparkles size={14} stroke={1.5} />}
            onClick={tidy}
            disabled={!loaded || locked}
          >
            {`Tidy · ${shownLayout}`}
          </Button>
        </header>
        <div
          ref={wrapRef}
          className="eva-cv-flow"
          data-tool={tool}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onPointerDownCapture={(e) => {
            if (!(e.target as HTMLElement).closest('input, textarea'))
              wrapRef.current?.focus({ preventScroll: true })
          }}
          onMouseDownCapture={(e) => {
            // The board's own buttons leave keyboard focus on the board, so its keys keep working.
            if ((e.target as HTMLElement).closest('button')) e.preventDefault()
          }}
        >
          <ReactFlow<CardNode, LinkEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={dragStart}
            onNodeDragStop={dragStop}
            onNodeDoubleClick={(_e, node) => {
              if (node.data.spec.type === 'image' && node.data.spec.data?.src)
                setLightboxId(node.id)
            }}
            onSelectionDragStart={dragStart}
            onSelectionDragStop={dragStop}
            onMoveEnd={(_e, vp) => {
              const quiet = quietViewRef.current
              if (quiet && quiet.x === vp.x && quiet.y === vp.y && quiet.zoom === vp.zoom) return
              quietViewRef.current = null
              if (loaded) scheduleSave()
            }}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={null}
            selectionKeyCode="Shift"
            multiSelectionKeyCode={['Meta', 'Shift']}
            zoomActivationKeyCode="Meta"
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            panOnDrag
            selectionOnDrag={false}
            nodesDraggable={!hand && !locked}
            nodesConnectable={!hand && !locked}
            elementsSelectable={!hand && !locked}
            minZoom={0.1}
            maxZoom={8}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <ToolBar
              tool={tool}
              onTool={setTool}
              onAddNote={addNoteAtCenter}
              disabled={!loaded || locked}
            />
            <BoardControls
              locked={locked}
              onLock={() => setLocked((l) => !l)}
              canUndo={history.past.length > 0 && !locked}
              canRedo={history.future.length > 0 && !locked}
              onUndo={doUndo}
              onRedo={doRedo}
            />
            <MiniMap<CardNode>
              className="eva-cv-minimap"
              style={{ width: 160, height: 110 }}
              pannable
              zoomable
              nodeBorderRadius={4}
              nodeClassName={(n) =>
                n.selected
                  ? 'eva-cv-mini-selected'
                  : `eva-cv-mini-${n.data.spec.type === 'topic' ? 'topic' : n.data.spec.type === 'frame' ? 'frame' : 'node'}`
              }
            />
            {single && !locked ? (
              <NodeActions
                nodeId={single.id}
                onCopy={() => copyTitle(single.id)}
                onHighlight={() => highlightLinks(single.id)}
                onAddNote={() => addLinkedNote(single.id)}
                onDelete={deleteSelected}
              />
            ) : null}
          </ReactFlow>
        </div>
        <Lightbox
          slug={slug}
          images={images}
          openId={lightboxId}
          onClose={() => setLightboxId(null)}
        />
      </div>
    </BoardContext.Provider>
  )
}

/** The open board, one per tab. */
export function CanvasBoardView({ slug }: { slug: string }) {
  return (
    <ReactFlowProvider>
      <Board key={slug} slug={slug} />
    </ReactFlowProvider>
  )
}
