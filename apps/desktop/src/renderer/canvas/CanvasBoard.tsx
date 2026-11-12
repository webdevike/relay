/**
 * One open board on React Flow (native canvas_view.rs): loads the file, places what has no
 * position (a quick layout first, then the layout engine with the drawn sizes), autosaves edits a
 * second after they settle, reloads outside edits (never during a drag) and keeps undo history.
 * Pointer and keys: drag empty space or scroll to pan, ⌘-scroll or pinch zooms, ⇧-drag
 * box-selects, ⌘A selects all, Escape clears, Backspace/Delete removes, ⌘Z / ⌘⇧Z undo and redo.
 * Double-clicking an image opens it full window. A card Isaac drags is pinned (canvas.layout
 * keeps it). A chat's agent works the board on screen through its driver
 * (agent/board-drivers.ts) with a visible cursor; Isaac's own edits while it acts take the board
 * over from it.
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
  useStoreApi,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { Button } from '@mantine/core'
import { IconSparkles } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type {
  CanvasBoard as BoardFile,
  CanvasNode,
  CanvasPage,
  CanvasThread,
  CanvasViewport,
  InvokeInput,
} from '@evaos/contract'
import { useAssistants } from '../assistants/assistants-store'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { invoke, on } from '../ipc'
import {
  FIT_PADDING,
  edgeId,
  effectiveLayout,
  engineGraph,
  engineOptions,
  layoutItems,
  nextNoteId,
  placeUnplaced,
  reloadPositions,
  roundHalfAway,
  visibleShare,
  titleOf,
} from './board-model'
import { onBoardOp } from './canvas-store'
import { liveRoomOn, liveStore, useLiveRooms } from './live/live-store'
import { carryOf, registerBoardCarry } from './live/handoff'
import { CanvasEdge } from './CanvasEdge'
import { BoardContext, type BoardActions } from './context'
import { BoardControls, NodeActions, ToolBar, type Tool } from './chrome'
import { CanvasCard } from './cards/CanvasCard'
import { PagePanel } from './PagePanel'
import { Lightbox } from './Lightbox'
import { boardImages } from './lightbox-model'
import { Comments, type NoteState } from './Comments'
import { anchorFor, nodeAt, pinPoint, routeOf, type Anchor, type Box } from './comment-model'
import { agentsOf } from '../chat/composer/at-menu'
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
import { type Point, type Size } from './layout'
import { layoutBoard } from '../../shared/canvas-layout'
import type { LayoutResult } from '../../shared/canvas-layout/types'
import { AgentCursorLayer, type CursorLayer } from './agent/AgentCursorLayer'
import { registerBoardDriver } from './agent/board-drivers'
import { easeInOut, REVEAL_MS, revealView, viewTarget, type Viewport } from './agent/cursor-model'
import { canvasAgentOp, shownRun, takesOver, useCanvasRuns } from './agent/runs-store'
import { frontWorkspace } from '../tiling/tiling-store'

const NODE_TYPES = { card: CanvasCard }
const EDGE_TYPES = { link: CanvasEdge }
/** The board's first page: the one a board opens on, and the only one a plain board has. */
const FIRST_PAGE = 'page-1'
const FIRST_PAGE_TITLE = 'Page 1'

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
  /** The positions came from the layout engine (the first paint's are the quick sync ones). */
  engine: boolean
  /** The engine is laying the board out for this round now. */
  pending: boolean
}

/** Points a link's route may keep in the file (CanvasEdgeSchema). */
const ROUTE_MAX = 40

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

/**
 * The board as the layout engine laid it out: cards at its positions (the rest where they are),
 * frames at its sizes, links on its sides along its routes (a return link drawn as a loop-back
 * unless it has a tone). `unpin` lets every card go (Tidy lays out the whole board afresh).
 */
function laidOut(
  doc: BoardDoc,
  laid: LayoutResult,
  unpin: boolean,
): { nodes: CardNode[]; edges: LinkEdge[]; positions: Map<string, Point> } {
  const positions = absolutePositions(doc.nodes)
  for (const [id, p] of laid.positions) positions.set(id, [p.x, p.y])
  const sizes = new Map<string, Size>()
  for (const [id, s] of laid.frameSizes) sizes.set(id, [s.w, s.h])
  const specs = withFrameSizes(specsOf(doc.nodes), sizes).map((s) => {
    if (!unpin || s.pinned === undefined) return s
    const { pinned: _pinned, ...rest } = s
    return rest
  })
  const selected = new Set(doc.nodes.filter((n) => n.selected).map((n) => n.id))
  const nodes = keepMeasured(toFlowNodes(specs, positions, selected), doc.nodes)
  const edges = doc.edges.map((e): LinkEdge => {
    const l = laid.edges.get(e.id)
    if (!l) return e
    const { route: _route, ...data } = e.data ?? {}
    const route = l.route.map((p) => ({ x: roundHalfAway(p.x), y: roundHalfAway(p.y) }))
    return {
      ...e,
      sourceHandle: l.sourceHandle,
      targetHandle: l.targetHandle,
      data: {
        ...data,
        ...(route.length >= 2 && route.length <= ROUTE_MAX ? { route } : {}),
        ...(l.loop && data.tone === undefined ? { tone: 'loop' } : {}),
      },
    }
  })
  return { nodes, edges, positions }
}

/** A board's links as the layout engine takes them. */
const engineEdges = (edges: readonly LinkEdge[]) =>
  edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.data?.label,
    tone: e.data?.tone,
  }))

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

/** Every card's box in board space, for pins (a pin sits on its card's top left plus an offset). */
function boxesOf(nodes: readonly CardNode[]): Map<string, Box> {
  const at = absolutePositions(nodes)
  const out = new Map<string, Box>()
  for (const n of nodes) {
    const p = at.get(n.id)
    if (!p) continue
    out.set(n.id, {
      x: p[0],
      y: p[1],
      w: n.measured?.width ?? n.width ?? 0,
      h: n.measured?.height ?? n.height ?? 0,
    })
  }
  return out
}

function saveLabel(state: SaveState): string {
  return typeof state === 'object' ? `not saved: ${state.error}` : state
}

function Board({
  slug,
  page,
  pages,
  onPage,
  onPages,
}: {
  slug: string
  page: string
  pages: readonly CanvasPage[]
  onPage: (page: string) => void
  onPages: (pages: CanvasPage[]) => void
}) {
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
  /** The page's comment pins and threads, the open one, and the comment being written. */
  const [threads, setThreads] = useState<CanvasThread[]>([])
  const [openThread, setOpenThread] = useState<string | null>(null)
  const [draft, setDraft] = useState<Anchor | null>(null)
  /** Where the pointer last was over the board (client pixels); null once it leaves. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null)

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
  /**
   * The cards the agent carried (one dragged card, or every card of a glide) with their React Flow
   * positions before, and the view before the carry, until main's write of that move lands
   * (`landed`) or the file reloads. `panned` is the view the carry left on screen.
   */
  const carriedRef = useRef<{
    from: Map<string, { x: number; y: number }>
    view: Viewport
    panned: Viewport | null
  } | null>(null)
  const goneRef = useRef(false)
  const unmountedRef = useRef(false)
  const fitPendingRef = useRef(false)
  /** A saved viewport to check once the nodes are drawn: it may come from a wider window. */
  const checkViewRef = useRef(false)
  /** A viewport the board moved to on its own (a rescue fit on open); reaching it doesn't save. */
  const quietViewRef = useRef<CanvasViewport | null>(null)
  const autoRef = useRef<AutoPlaced | null>(null)
  /** The save in flight, for a flush to wait on. */
  const savingRef = useRef<Promise<unknown> | null>(null)
  /** The pages' latest list, for callbacks that must not rebuild when it changes. */
  const onPagesRef = useRef(onPages)
  onPagesRef.current = onPages
  /** Whether a live room holds the board: its pages can be read but not changed from here. */
  const liveOn = useLiveRooms((s) => liveRoomOn(s.data, slug) !== null)

  const snapshot = useCallback((): Snapshot<BoardDoc> => {
    const doc = docRef.current
    return { key: JSON.stringify(toBoard(doc, null)), value: doc }
  }, [])

  /** The agent's run on this board; Isaac's own edits take it over while it acts. */
  const run = useCanvasRuns((s) => shownRun(s.runs, slug))
  const runRef = useRef(run)
  runRef.current = run
  /** Take over was asked for this stretch of the agent's work; cleared once it stops acting. */
  const pausingRef = useRef(false)
  if (!takesOver(run?.status)) pausingRef.current = false
  /** An edit of Isaac's (undo steps, drags, resizes, page changes): the agent pauses for him. */
  const isaacEdited = useCallback(() => {
    if (!takesOver(runRef.current?.status) || pausingRef.current) return
    pausingRef.current = true
    void canvasAgentOp(slug, 'takeOver').then((ok) => {
      if (!ok) pausingRef.current = false
    })
  }, [slug])

  /** Records the board before an action, as one undo step (an edit of Isaac's). */
  const remember = useCallback(() => {
    isaacEdited()
    setHistory((h) => record(h, snapshot()))
  }, [snapshot, isaacEdited])

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

  // A live room that takes this board over (it loads behind the board, live/handoff.ts) opens on
  // what is shown here: this page, its view, the selection and the open thread.
  const openThreadRef = useRef(openThread)
  openThreadRef.current = openThread
  useEffect(
    () =>
      registerBoardCarry(slug, () =>
        carryOf({
          page,
          viewport: flow.getViewport(),
          nodes: docRef.current.nodes,
          thread: openThreadRef.current,
        }),
      ),
    [slug, page, flow],
  )

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
    // Cards the agent is carrying save where they were: only main's guarded write lands the move.
    const c = carriedRef.current
    const doc = c
      ? {
          ...docRef.current,
          nodes: docRef.current.nodes.map((n) => {
            const from = c.from.get(n.id)
            return from ? { ...n, position: from } : n
          }),
        }
      : docRef.current
    const board = toBoard(doc, viewToSave())
    const key = JSON.stringify(board)
    if (key === syncedRef.current) {
      setSave('saved')
      return
    }
    setSave('saving')
    const saving = invoke('canvas.save', { slug, board, page })
    savingRef.current = saving
    const r = await saving
    if (goneRef.current) return
    if (r.ok) {
      syncedRef.current = key
      // A newer edit keeps the board unsaved until its own save.
      if (timerRef.current === undefined) setSave('saved')
    } else setSave({ error: r.error.message })
  }, [viewToSave, slug, page])

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
              engine: false,
              pending: false,
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
    void invoke('canvas.load', { slug, page }).then((r) => {
      if (!live) return
      if (!r.ok) {
        setFailure(r.error.code === 'not-found' ? 'This board is gone.' : r.error.message)
        return
      }
      onPagesRef.current(r.value.pages)
      // A page the file no longer has: show the one it gives instead (a fresh load of that page).
      if (r.value.page !== page) {
        onPage(r.value.page)
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
  }, [slug, page, onPage, apply, flow, saveIfChanged])

  // Leaving the board saves what is pending.
  useEffect(() => {
    // The effect reruns when `saveNow` changes, which is not leaving the board.
    unmountedRef.current = false
    return () => {
      unmountedRef.current = true
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current)
        void saveNow()
      }
    }
  }, [saveNow])

  const reload = useCallback(async () => {
    reloadPendingRef.current = false
    const r = await invoke('canvas.load', { slug, page })
    if (goneRef.current) return
    if (!r.ok) {
      if (r.error.code === 'not-found') {
        goneRef.current = true
        setFailure('This board is gone.')
      } else setSave({ error: `file not loaded: ${r.error.message}` })
      return
    }
    onPagesRef.current(r.value.pages)
    // The page was deleted outside: the board moves to the page the file shows instead.
    if (r.value.page !== page) {
      clearTimeout(timerRef.current)
      timerRef.current = undefined
      onPage(r.value.page)
      return
    }
    const key = JSON.stringify(r.value.board)
    if (key === syncedRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    syncedRef.current = key
    apply(r.value.board)
    // The file changed under a carried card: main's write of the move landed (or the file now
    // says where it is); either way it is no longer the agent's to take back.
    carriedRef.current = null
    setSave('saved')
    saveIfChanged()
  }, [apply, saveIfChanged, slug, page, onPage])

  /** Saves what is pending (or waits for the save in flight), so the file is as the board is. */
  const flush = useCallback(async () => {
    if (timerRef.current === undefined) {
      await savingRef.current
      return
    }
    clearTimeout(timerRef.current)
    await saveNow()
  }, [saveNow])

  /** Switching pages saves this one first; the next page loads in a fresh board (undo starts over). */
  const switchTo = useCallback(
    async (id: string) => {
      await flush()
      onPage(id)
    },
    [flush, onPage],
  )

  const pageOp = useCallback(
    async (op: Omit<InvokeInput<'canvas.pages'>, 'slug'>) => {
      if (liveOn) return
      isaacEdited()
      await flush()
      const r = await invoke('canvas.pages', { slug, ...op })
      if (goneRef.current || unmountedRef.current) return
      if (!r.ok) {
        setSave({ error: r.error.message })
        return
      }
      onPagesRef.current(r.value.pages)
      const moved =
        op.op === 'add' || op.op === 'duplicate' || (op.op === 'delete' && op.page === page)
      if (moved && r.value.page !== page) onPage(r.value.page)
    },
    [flush, isaacEdited, liveOn, onPage, page, slug],
  )

  /** The page's comment threads, as the board file has them. */
  const loadThreads = useCallback(async () => {
    const r = await invoke('canvas.threads', { slug, page })
    if (goneRef.current || unmountedRef.current) return
    if (r.ok) setThreads(r.value.threads)
  }, [slug, page])

  useEffect(() => {
    void loadThreads()
  }, [loadThreads])

  /**
   * A comment: on the selected card, else the card under the pointer, else the board spot there,
   * else the middle of the view. The button passes `usePointer: false` (the pointer is on it).
   */
  const startComment = useCallback(
    (usePointer: boolean) => {
      if (!loaded) return
      const boxes = boxesOf(docRef.current.nodes)
      const p = usePointer ? pointerRef.current : null
      const at = p ? flow.screenToFlowPosition(p) : null
      const selected = docRef.current.nodes.find((n) => n.selected)
      const selectedBox = selected ? boxes.get(selected.id) : undefined
      const target =
        selected && selectedBox
          ? { id: selected.id, box: selectedBox }
          : at
            ? nodeAt(at, boxes)
            : null
      const r = wrapRef.current?.getBoundingClientRect()
      const middle = r
        ? flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        : { x: 0, y: 0 }
      setOpenThread(null)
      setDraft(anchorFor(target ? at : (at ?? middle), target))
    },
    [flow, loaded],
  )

  const threadOp = useCallback(
    async (op: InvokeInput<'canvas.threads'>['op']) => {
      const r = await invoke('canvas.threads', { slug, page, op })
      if (!r.ok) throw new Error(r.error.message)
      if (goneRef.current || unmountedRef.current) return null
      setThreads(r.value.threads)
      return r.value.opened ?? null
    },
    [slug, page],
  )

  /** Who an `@` can name: the registry's assistants. */
  const agents = useAssistants((s) => s.data?.agents)
  const mentionables = useMemo(() => agentsOf(agents ?? []), [agents])
  /** Each thread's last note to the chat that works on the board: on its way, sent, or refused. */
  const [notes, setNotes] = useState<Record<string, NoteState>>({})
  const setNote = (thread: string, state: NoteState): void => {
    if (goneRef.current || unmountedRef.current) return
    setNotes((all) => ({ ...all, [thread]: state }))
  }

  /**
   * Sends a saved comment to the chat that owns the board as Isaac's message: the thread's agent
   * when it has one, else the chat whose agent works the board, else the chat of the workspace
   * the board is shown in (main decides, `agent.note`).
   */
  const sendNote = async (
    thread: string,
    text: string,
    anchor: Anchor,
    reply: boolean,
    assignee: string | null,
  ): Promise<void> => {
    setNote(thread, { phase: 'sending' })
    const doc = docRef.current
    const card = anchor.node === undefined ? undefined : doc.nodes.find((n) => n.id === anchor.node)
    const r = await invoke('agent.note', {
      note: {
        surface: 'canvas',
        text: text.slice(0, 4000),
        slug,
        board: doc.title.slice(0, 500),
        page,
        thread,
        ...(card ? { node: { id: card.id, title: titleOf(card.data.spec).slice(0, 200) } } : {}),
        at: pinPoint(anchor, boxesOf(doc.nodes)) ?? { x: anchor.x, y: anchor.y },
        reply,
        ...(assignee === null ? {} : { assignee }),
      },
      workspace: frontWorkspace() || null,
    })
    if (!r.ok) setNote(thread, { phase: 'refused', message: r.error.message })
    else if (r.value.sent) setNote(thread, { phase: 'sent', to: r.value.to })
    else setNote(thread, { phase: 'refused', message: 'Not sent: no chat works on this board' })
  }

  const commentProps = {
    mentionables,
    notes,
    onStart: async (text: string) => {
      if (!draft) return
      const { assignee } = routeOf(text, mentionables, null)
      const opened = await threadOp({
        op: 'open',
        ...draft,
        text,
        ...(assignee === null ? {} : { assignee }),
      })
      setDraft(null)
      setOpenThread(opened)
      if (opened !== null) void sendNote(opened, text, draft, false, assignee)
    },
    onReply: async (thread: string, text: string) => {
      // A thread keeps its agent: a reply that names no one goes to the one it has.
      const current = threads.find((t) => t.id === thread)
      const { assignee } = routeOf(text, mentionables, current?.assignee)
      await threadOp({ op: 'post', thread, text, ...(assignee === null ? {} : { assignee }) })
      if (current) void sendNote(thread, text, current, true, assignee)
    },
    onResolve: (thread: string, resolved: boolean) => {
      threadOp({ op: 'resolve', thread, resolved }).then(
        () => {
          if (resolved) setOpenThread(null)
        },
        (e: unknown) => setSave({ error: e instanceof Error ? e.message : String(e) }),
      )
    },
    onMove: (thread: string, anchor: { node?: string; x: number; y: number }) => {
      threadOp({ op: 'move', thread, ...anchor }).catch((e: unknown) =>
        setSave({ error: e instanceof Error ? e.message : String(e) }),
      )
    },
  }

  // An outside edit reloads the board, after any drag in progress.
  useEffect(
    () =>
      on('canvas.changed', (e) => {
        if (e.slug !== slug || !syncedRef.current) return
        void loadThreads()
        if (draggingRef.current) reloadPendingRef.current = true
        else void reload()
      }),
    [reload, slug, loadThreads],
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

  // A board opened with no positions shows the quick sync layout first; once every card is drawn
  // the layout engine lays it out with the drawn sizes (links routed), and again whenever drawn
  // sizes differ from the ones used (images arriving). Stops at the first move.
  useEffect(() => {
    const auto = autoRef.current
    if (!auto || !initialized) return
    const t = setTimeout(() => {
      // A move (Isaac's, or the agent taking the view) since this round started ends settling.
      if (autoRef.current !== auto || auto.pending) return
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
      const measured = measuredSizes(doc.nodes)
      const items = layoutItems(specs, measured)
      const changed = items.some((i) => {
        const s = auto.sizes.get(i.id)
        return !s || Math.abs(s[0] - i.w) > SETTLE_SLACK || Math.abs(s[1] - i.h) > SETTLE_SLACK
      })
      if ((auto.engine && !changed) || auto.rounds >= SETTLE_ROUNDS) {
        if (!auto.quiet) {
          auto.quiet = true
          saveIfChanged()
        }
        return
      }
      const fileLayout = effectiveLayout(doc.layout, specs, doc.edges.length > 0)
      const graph = engineGraph(specs, engineEdges(doc.edges), abs, measured)
      auto.pending = true
      layoutBoard(graph.nodes, graph.edges, engineOptions(fileLayout, specs, true)).then(
        (laid) => {
          auto.pending = false
          // Stale: the board reloaded, or a move ended settling, while the engine ran.
          if (autoRef.current !== auto || unmountedRef.current) return
          const next = laidOut(docRef.current, laid, false)
          // Frames as the engine grew them, so the next check compares the cards' drawn sizes.
          const used = layoutItems(specsOf(next.nodes), measured)
          autoRef.current = {
            sizes: new Map(used.map((i) => [i.id, [i.w, i.h] as Size])),
            positions: next.positions,
            rounds: auto.rounds + 1,
            quiet: false,
            engine: true,
            pending: false,
          }
          setNodes(next.nodes)
          setEdges(next.edges)
          fitPendingRef.current = true
          requestAnimationFrame(() => {
            if (!fitPendingRef.current) return
            fitPendingRef.current = false
            void flow.fitView({ padding: FIT_PADDING }).then(() => scheduleSave())
          })
        },
        () => {
          // The engine failed: the quick layout stays and saves.
          auto.pending = false
          if (autoRef.current !== auto || auto.quiet) return
          auto.quiet = true
          saveIfChanged()
        },
      )
    }, 250)
    return () => clearTimeout(t)
  }, [nodes, initialized, flow, scheduleSave, saveIfChanged])

  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) => {
      // Removing goes through deleteSelected, which keeps children of a deleted frame.
      const kept = changes.filter((c) => c.type !== 'remove')
      setNodes((ns) => applyNodeChanges(kept, ns))
      // React Flow only moves or resizes nodes for Isaac (the agent's drags set the nodes directly).
      const edit = kept.some(
        (c) =>
          (c.type === 'position' && !c.dragging) ||
          // A resize by Isaac carries `resizing`; React Flow also reports a frame taking the size
          // the layout gave it (setAttributes without it), which is not his edit.
          (c.type === 'dimensions' && c.setAttributes && c.resizing !== undefined),
      )
      const sized = kept.some((c) => c.type === 'dimensions' && c.setAttributes)
      if (edit || sized) {
        if (edit) isaacEdited()
        scheduleSave()
      }
    },
    [scheduleSave, isaacEdited],
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

  /** Isaac's drag ends: the cards he moved are pinned (canvas.layout keeps them where they are). */
  const dragStop = useCallback(
    (dragged: readonly CardNode[]) => {
      draggingRef.current = false
      autoRef.current = null
      const pins = new Set(dragged.filter((n) => !n.data.spec.pinned).map((n) => n.id))
      if (pins.size > 0) {
        setNodes((ns) =>
          ns.map((n) =>
            pins.has(n.id)
              ? { ...n, data: { ...n.data, spec: { ...n.data.spec, pinned: true } } }
              : n,
          ),
        )
      }
      scheduleSave()
      if (reloadPendingRef.current) void reload()
    },
    [reload, scheduleSave],
  )

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
    isaacEdited()
    restore(r.state)
  }, [restore, snapshot, isaacEdited])

  const doRedo = useCallback(() => {
    const r = redo(historyRef.current, snapshot())
    if (!r) return
    setHistory(r.history)
    isaacEdited()
    restore(r.state)
  }, [restore, snapshot, isaacEdited])

  /** The Tidy in flight; a newer one (or an edit meanwhile) drops its result. */
  const tidyRef = useRef(0)
  /** Lays the whole board out afresh with the layout engine (pins let go), as one undo step. */
  const tidy = useCallback(() => {
    remember()
    const doc = docRef.current
    const before = snapshot().key
    const run = ++tidyRef.current
    const specs = specsOf(doc.nodes)
    const fileLayout = effectiveLayout(doc.layout, specs, doc.edges.length > 0)
    const graph = engineGraph(
      specs,
      engineEdges(doc.edges),
      absolutePositions(doc.nodes),
      measuredSizes(doc.nodes),
    )
    autoRef.current = null
    layoutBoard(graph.nodes, graph.edges, engineOptions(fileLayout, specs, false)).then(
      (laid) => {
        if (run !== tidyRef.current || unmountedRef.current || goneRef.current) return
        if (snapshot().key !== before) return
        const next = laidOut(docRef.current, laid, true)
        setNodes(next.nodes)
        setEdges(next.edges)
        autoRef.current = null
        requestAnimationFrame(
          () => void flow.fitView({ padding: FIT_PADDING }).then(() => scheduleSave()),
        )
      },
      (e: unknown) =>
        setSave({ error: `not tidied: ${e instanceof Error ? e.message : String(e)}` }),
    )
  }, [flow, remember, scheduleSave, snapshot])

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

  // `/` writes a comment from anywhere on the page: focus on the board, on nothing, or on another
  // control (the sidebar row that opened the board), but never in a field or while the board is hidden.
  useEffect(() => {
    const onSlash = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (!wrapRef.current || wrapRef.current.getClientRects().length === 0) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])'))
        return
      e.preventDefault()
      startComment(true)
    }
    window.addEventListener('keydown', onSlash)
    return () => window.removeEventListener('keydown', onSlash)
  }, [startComment])

  // Main's canvas drive works this board while it is on screen (agent/board-drivers.ts): the
  // agent's cursor, its view, selection and the cards it carries, none of them Isaac's edits.
  const store = useStoreApi()
  const cursorRef = useRef<CursorLayer | null>(null)
  const carryRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    // The agent moving the view takes it over, as Isaac's own pan would: the open's pending fit
    // and the settling relayout's refit would otherwise snap the board away from its work.
    const takeView = (): void => {
      autoRef.current = null
      fitPendingRef.current = false
      checkViewRef.current = false
    }
    const off = registerBoardDriver({
      slug,
      page,
      shown: () => (wrapRef.current?.getClientRects().length ?? 0) > 0,
      // Hide comes when Isaac takes over or the run ends: cards the agent carried whose write
      // has not landed yet go back, so his next save never keeps a move main refused, and the
      // board goes back to where it was with them (unless Isaac moved the view himself since).
      cursor: (op) => {
        if (op.op === 'hide') {
          const c = carriedRef.current
          carriedRef.current = null
          if (c) {
            cancelAnimationFrame(carryRef.current ?? 0)
            carryRef.current = undefined
            draggingRef.current = false
            setNodes((ns) =>
              ns.map((n) => {
                const from = c.from.get(n.id)
                return from ? { ...n, position: from } : n
              }),
            )
            // The view is still the one the carry left: Isaac did not move it himself.
            const vp = flow.getViewport()
            const p = c.panned
            const still =
              p !== null &&
              Math.abs(vp.x - p.x) < 0.5 &&
              Math.abs(vp.y - p.y) < 0.5 &&
              Math.abs(vp.zoom - p.zoom) < 1e-3
            if (still) {
              const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
              void flow.setViewport(c.view, { duration: reduce ? 0 : REVEAL_MS })
            }
            if (reloadPendingRef.current) void reload()
          }
        }
        return cursorRef.current?.cursor(op) ?? 0
      },
      flush,
      boxes: () => boxesOf(docRef.current.nodes),
      select: (ids) => {
        const picked = new Set(ids)
        setNodes((ns) =>
          ns.map((n) =>
            picked.has(n.id) === Boolean(n.selected) ? n : { ...n, selected: picked.has(n.id) },
          ),
        )
        setEdges((es) => es.map((e) => (e.selected ? { ...e, selected: false } : e)))
      },
      view: async ({ zoom, center, fit, pan, duration }) => {
        takeView()
        const timing = duration === undefined ? {} : { duration }
        if (fit) await flow.fitView({ padding: FIT_PADDING, ...timing })
        else {
          const { width, height } = store.getState()
          const target = viewTarget(
            flow.getViewport(),
            { w: width, h: height },
            { zoom, center, pan },
          )
          await flow.setViewport(target, timing)
        }
        return flow.getViewport()
      },
      reveal: (need, want) => {
        const { width, height } = store.getState()
        const target = revealView(flow.getViewport(), { w: width, h: height }, need, want)
        if (!target) return 0
        takeView()
        const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : REVEAL_MS
        void flow.setViewport(target, { duration: ms })
        return ms
      },
      // The card rides along with the cursor, eased; main's file write that follows lands it
      // where it already is. Reloads wait until it arrives. When its new spot is out of view the
      // board pans in the same easing, so card and cursor stay on screen the whole way.
      drag: (node, to, ms) => {
        const doc = docRef.current
        const card = doc.nodes.find((n) => n.id === node)
        const abs = absolutePositions(doc.nodes).get(node)
        const box = boxesOf(doc.nodes).get(node)
        if (!card || !abs || !box) return 0
        cancelAnimationFrame(carryRef.current ?? 0)
        const from = card.position
        const view = flow.getViewport()
        const { width, height } = store.getState()
        const end = revealView(view, { w: width, h: height }, { ...box, x: to.x, y: to.y })
        const carried = { from: new Map([[node, from]]), view, panned: end ? view : null }
        carriedRef.current = carried
        if (end) takeView()
        const dest = { x: from.x + to.x - abs[0], y: from.y + to.y - abs[1] }
        const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
        cursorRef.current?.hold(node)
        draggingRef.current = true
        autoRef.current = null
        const t0 = performance.now()
        const step = (now: number): void => {
          const k = dur === 0 ? 1 : Math.min(1, Math.max(0, now - t0) / dur)
          const e = easeInOut(k)
          const position = { x: from.x + (dest.x - from.x) * e, y: from.y + (dest.y - from.y) * e }
          setNodes((ns) => ns.map((n) => (n.id === node ? { ...n, position } : n)))
          if (end) {
            const at = {
              x: view.x + (end.x - view.x) * e,
              y: view.y + (end.y - view.y) * e,
              zoom: view.zoom + (end.zoom - view.zoom) * e,
            }
            carried.panned = at
            void flow.setViewport(at)
          }
          if (k < 1) {
            carryRef.current = requestAnimationFrame(step)
            return
          }
          carryRef.current = undefined
          draggingRef.current = false
          if (reloadPendingRef.current) void reload()
        }
        carryRef.current = requestAnimationFrame(step)
        return dur
      },
      // Every named card glides from where it is to its absolute top left in `to` at once (cards
      // inside a moving frame keep their own spot unless named too), eased, as one undo step
      // taken before; main's file write that follows lands them where they already are. Saves
      // and reloads wait until they arrive; a hide before the write lands takes them all back.
      arrange: (to, ms) => {
        const doc = docRef.current
        const abs = absolutePositions(doc.nodes)
        const byId = new Map(doc.nodes.map((n) => [n.id, n]))
        const goal = new Map(Object.entries(to).filter(([id]) => byId.has(id)))
        if (goal.size === 0) return 0
        const inGlide = (n: CardNode): boolean => {
          for (let p = n.parentId; p !== undefined; p = byId.get(p)?.parentId) {
            if (goal.has(p)) return true
          }
          return goal.has(n.id)
        }
        const moving = doc.nodes.filter(inGlide)
        const before = snapshot()
        setHistory((h) => record(h, before))
        cancelAnimationFrame(carryRef.current ?? 0)
        carriedRef.current = {
          from: new Map(moving.map((n) => [n.id, n.position])),
          view: flow.getViewport(),
          panned: null,
        }
        draggingRef.current = true
        autoRef.current = null
        const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
        const start = new Map(moving.map((n) => [n.id, abs.get(n.id) ?? [0, 0]]))
        const t0 = performance.now()
        const step = (now: number): void => {
          const k = dur === 0 ? 1 : Math.min(1, Math.max(0, now - t0) / dur)
          const e = easeInOut(k)
          // Where a card is drawn at this step, absolute: its glide, or where it stays.
          const at = (id: string): { x: number; y: number } => {
            const [x0, y0] = start.get(id) ?? abs.get(id) ?? [0, 0]
            const g = goal.get(id)
            return g ? { x: x0 + (g.x - x0) * e, y: y0 + (g.y - y0) * e } : { x: x0, y: y0 }
          }
          setNodes((ns) =>
            ns.map((n) => {
              if (!start.has(n.id)) return n
              const me = at(n.id)
              const up = n.parentId === undefined ? { x: 0, y: 0 } : at(n.parentId)
              return { ...n, position: { x: me.x - up.x, y: me.y - up.y } }
            }),
          )
          if (k < 1) {
            carryRef.current = requestAnimationFrame(step)
            return
          }
          carryRef.current = undefined
          draggingRef.current = false
          if (reloadPendingRef.current) void reload()
        }
        carryRef.current = requestAnimationFrame(step)
        return dur
      },
      landed: (node) => {
        if (carriedRef.current?.from.has(node)) carriedRef.current = null
      },
      goTo: (to) => void switchTo(to),
    })
    return () => {
      off()
      cancelAnimationFrame(carryRef.current ?? 0)
    }
  }, [slug, page, flow, flush, store, reload, switchTo, snapshot])

  const selectedNodes = nodes.filter((n) => n.selected)
  const single = selectedNodes.length === 1 ? selectedNodes[0]! : null
  const specs = useMemo(() => nodes.map((n) => n.data.spec), [nodes])
  const boxes = useMemo(() => boxesOf(nodes), [nodes])
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
          onPointerMove={(e) => {
            pointerRef.current = { x: e.clientX, y: e.clientY }
          }}
          onPointerLeave={() => {
            pointerRef.current = null
          }}
          onPointerDownCapture={(e) => {
            if (!(e.target as HTMLElement).closest('input, textarea, [data-cv-pages]'))
              wrapRef.current?.focus({ preventScroll: true })
          }}
          onMouseDownCapture={(e) => {
            // The board's own buttons leave keyboard focus on the board, so its keys keep working.
            if (
              (e.target as HTMLElement).closest('button') &&
              !(e.target as HTMLElement).closest('[data-cv-pages]')
            )
              e.preventDefault()
          }}
        >
          <PagePanel
            pages={pages}
            page={page}
            editable={!liveOn && loaded}
            onSwitch={(id) => {
              isaacEdited()
              void switchTo(id)
            }}
            onAdd={() => void pageOp({ op: 'add', page })}
            onRename={(id, t) => void pageOp({ op: 'rename', page: id, title: t })}
            onMove={(id, to) => void pageOp({ op: 'move', page: id, to })}
            onDuplicate={(id) => void pageOp({ op: 'duplicate', page: id })}
            onDelete={(id) => void pageOp({ op: 'delete', page: id })}
          />
          <ReactFlow<CardNode, LinkEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={dragStart}
            onNodeDragStop={(_e, _node, dragged) => dragStop(dragged)}
            onNodeDoubleClick={(_e, node) => {
              if (node.data.spec.type === 'image' && node.data.spec.data?.src)
                setLightboxId(node.id)
            }}
            onSelectionDragStart={dragStart}
            onSelectionDragStop={(_e, dragged) => dragStop(dragged)}
            // His own pan or zoom (an event; the agent's reveals and fits have none) takes over,
            // as his scroll does in the shared browser, so the next reveal never fights him.
            onMoveStart={(e) => {
              if (e) isaacEdited()
            }}
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
              onComment={() => startComment(false)}
              disabled={!loaded || locked}
              canComment={loaded}
            />
            <Comments
              threads={threads}
              boxes={boxes}
              draft={draft}
              openId={openThread}
              onOpen={setOpenThread}
              onCancelDraft={() => setDraft(null)}
              {...commentProps}
            />
            <AgentCursorLayer handle={cursorRef} boxes={boxes} />
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

/** The pages' state outlives a board's remount: switching pages loads that page afresh. */
function BoardSession({ slug }: { slug: string }) {
  const [page, setPage] = useState(FIRST_PAGE)
  const [pages, setPages] = useState<CanvasPage[]>([{ id: FIRST_PAGE, title: FIRST_PAGE_TITLE }])
  return (
    <ReactFlowProvider>
      <Board
        key={`${slug}:${page}`}
        slug={slug}
        page={page}
        pages={pages}
        onPage={setPage}
        onPages={setPages}
      />
    </ReactFlowProvider>
  )
}

/** The open board, one per tab. */
export function CanvasBoardView({ slug }: { slug: string }) {
  return <BoardSession key={slug} slug={slug} />
}
