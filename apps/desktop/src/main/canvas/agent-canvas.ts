import type {
  AgentRunOp,
  AgentRunStatus,
  CanvasBoard,
  CanvasBoardAnswer,
  CanvasBoardCall,
  CanvasCursorOp,
  CanvasNodeData,
  CanvasNodeKind,
  CanvasRun,
} from '@evaos/contract'
import { AgentRuns, fail } from '../agent-presence/agent-runs'
import type { DriveIdentity } from '../browser/agent-drive'
import { alignNodes, distributeNodes, layoutBoard } from '../../shared/canvas-layout'
import type { AlignTo, LayoutAlgorithm, LayoutDirection } from '../../shared/canvas-layout/types'
import {
  addCard,
  arrangeCards,
  boxesOf,
  connectCards,
  descendantsOf,
  editCard,
  grownFrame,
  layoutGraph,
  moveCard,
  nodeOf,
  placeNew,
  readout,
  removeItems,
  typicalSize,
  withFrameChildren,
  type Box,
} from './board-edit'
import type { CanvasStore } from './store'

/**
 * A chat's agent working a board in front of Isaac (the canvas.* agent actions), like the browser
 * drive works a page: one run per board (AgentRuns: ring, caption, Take over / Hand back), the
 * agent's cursor travelling to each change on the board on screen before it lands, and every
 * change written to `<slug>.json` through the board store, which the open board reloads at once.
 * The board on screen answers the `@canvas` calls (CanvasBoardCall); a board that is not on screen
 * still gets every change, without the cursor (docs/agent-presence.md).
 */

export interface CanvasDriveDeps {
  store: Pick<CanvasStore, 'load' | 'update' | 'create' | 'rename' | 'threads'>
  /** The board on screen (renderer `@canvas`); `{mounted: false}` when none shows `slug`. */
  board(call: CanvasBoardCall): Promise<CanvasBoardAnswer>
  /** Tells the open board its file changed (`canvas.changed`). */
  changed(slug: string): void
  /** Every run, as `canvas.runs` publishes them. */
  publish(runs: CanvasRun[]): void
  /** Who the calling session is (face, color, portrait, its chat's workspace). */
  identify(scope: string | undefined): Promise<DriveIdentity>
  /** Shows the board on the Canvas page in the caller's workspace. */
  show(slug: string, scope: string | undefined): Promise<void>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** How long canvas.open waits for the board to come up on screen. */
const MOUNT_WAIT_MS = 4_000
/** Ms the dotted route and target show before the cursor travels (browser CURSOR_LEAD_MS). */
const LEAD_MS = 260
/** How long a carried card takes to reach its new spot. */
const DRAG_MS = 650
/** How long cards laid out, aligned or distributed take to glide to their new spots. */
const ARRANGE_MS = 700
/** canvas.layout's gap between cards when the agent names none (board px). */
const SPACING = 56
/** Where the cursor rests on a new card: just inside its top left. */
const INSET = 28
/** Board units shown around a comment pin the agent replies at. */
const PIN_ROOM = 48
const FIRST_PAGE = 'page-1'

function realSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

interface Where {
  board: string
  page: string
}

export class CanvasDrive {
  private readonly runs: AgentRuns<string, DriveIdentity>
  private readonly shown = new Map<string, CanvasRun>()
  private readonly where = new Map<string, Where>()
  /** The run epoch each board's action in flight began in (one action per board at a time). */
  private readonly acting = new Map<string, number>()
  /** Each board's actions, one after another. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: CanvasDriveDeps) {
    const now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? realSleep
    this.runs = new AgentRuns<string, DriveIdentity>(
      {
        publish: (slug, run) => {
          const at = this.where.get(slug) ?? { board: slug, page: FIRST_PAGE }
          const who = this.runs.who(slug)
          this.shown.set(slug, {
            ...run,
            background: false,
            slug,
            board: at.board,
            page: at.page,
            workspace: who?.workspace ?? null,
          })
          deps.publish(this.list())
        },
        hideCursor: (slug) => {
          const page = this.where.get(slug)?.page ?? FIRST_PAGE
          void this.call({ op: 'cursor', slug, page, cursor: { op: 'hide' } })
        },
      },
      { noun: 'board', wait: 'canvas.wait' },
      now,
    )
  }

  /** Every board an agent works or worked, newest first. */
  list(): CanvasRun[] {
    return [...this.shown.values()].sort((a, b) => b.since - a.since)
  }

  /** The workspace of the chat whose agent works (or last worked) `slug`, else null. */
  workspaceOf(slug: string): string | null {
    return this.runs.who(slug)?.workspace ?? null
  }

  /** Isaac's controls on a board's run: Take over, Hand back, dismiss. */
  op(slug: string, op: AgentRunOp): void {
    this.runs.op(slug, op)
  }

  // Board on screen ------------------------------------------------------------------------------

  private async call(c: CanvasBoardCall): Promise<CanvasBoardAnswer> {
    try {
      return await this.deps.board(c)
    } catch {
      return { mounted: false, ms: 0 }
    }
  }

  /** Moves (or clicks) the agent's cursor on the board and waits while it travels. */
  private async cursor(
    slug: string,
    page: string,
    op: Omit<CanvasCursorOp, 'color' | 'avatar' | 'initial' | 'lead'>,
  ): Promise<boolean> {
    const who = this.runs.who(slug)
    const face = who
      ? {
          color: who.color,
          initial: who.name.slice(0, 1),
          ...(who.avatar ? { avatar: who.avatar } : {}),
        }
      : {}
    const lead = op.op === 'move' ? { lead: LEAD_MS } : {}
    this.stillMine(slug)
    const a = await this.call({ op: 'cursor', slug, page, cursor: { ...op, ...lead, ...face } })
    if (a.mounted && a.ms) await this.sleep(a.ms)
    return a.mounted
  }

  /**
   * Brings what the agent is about to work on (cards `nodes`, flow box `box`) into view on the board
   * on screen, like the browser drive scrolls to an element, and waits while the board moves. The
   * cards `context` and box `around` show too when they fit readably.
   */
  private async reveal(
    slug: string,
    page: string,
    what: { nodes?: string[]; box?: Box; context?: string[]; around?: Box },
  ): Promise<void> {
    this.stillMine(slug)
    const a = await this.call({ op: 'reveal', slug, page, ...what })
    if (a.mounted && a.ms) await this.sleep(a.ms)
  }

  /** Cards' boxes as drawn when the board is on screen, else from the file. */
  private async boxes(slug: string, page: string, board: CanvasBoard): Promise<Map<string, Box>> {
    const a = await this.call({ op: 'boxes', slug, page })
    return boxesOf(board.nodes, a.mounted ? (a.boxes ?? null) : null)
  }

  /**
   * The action in flight may go on: its run is still working in the epoch it began in. Isaac
   * taking over (or the run ending) since then stops it before anything more lands.
   */
  private stillMine(slug: string): void {
    const status = this.runs.view(slug)?.status
    if (status === 'paused') {
      fail('paused-by-isaac', 'Isaac took over this board. canvas.wait until handback')
    }
    if (status !== 'working' || this.runs.epoch(slug) !== this.acting.get(slug)) {
      fail('stopped', 'This run on the board ended while the action ran; nothing more landed')
    }
  }

  /** Runs `act` once the board's earlier actions are through, so their steps never interleave. */
  private serial<T>(slug: string, act: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(slug) ?? Promise.resolve()).then(act, act)
    const tail = run.catch(() => {})
    this.queues.set(slug, tail)
    void tail.then(() => {
      if (this.queues.get(slug) === tail) this.queues.delete(slug)
    })
    return run
  }

  // Runs -----------------------------------------------------------------------------------------

  /** The board's page the action works on (the run's page unless it names one) and its title. */
  private async page(slug: string, page: string | undefined): Promise<Where & { b: CanvasBoard }> {
    const want = page ?? this.where.get(slug)?.page
    const shown = await this.deps.store.load(slug, want)
    if (page !== undefined && shown.page !== page) {
      fail('not-found', `No page ${page} on board ${slug}; canvas.read lists its pages`)
    }
    return { board: shown.board.title || slug, page: shown.page, b: shown.board }
  }

  /**
   * Starts or continues the caller's run on the board: it becomes `working`. A refused caller
   * (Isaac drives, another chat's run) changes nothing.
   */
  private async begin(
    slug: string,
    page: string | undefined,
    scope: string | undefined,
    caption: string | undefined,
  ): Promise<Where & { b: CanvasBoard; who: DriveIdentity }> {
    const who = await this.deps.identify(scope)
    this.runs.admit(slug, who)
    const at = await this.page(slug, page)
    // Isaac may have taken over while the page loaded: nothing changes for a refused action.
    this.runs.admit(slug, who)
    this.where.set(slug, { board: at.board, page: at.page })
    this.runs.begin(slug, who, caption)
    this.acting.set(slug, this.runs.epoch(slug))
    return { ...at, who }
  }

  private auto(slug: string, text: string): void {
    this.runs.caption(slug, text, true)
  }

  /**
   * Saves the board's pending edits, then applies `edit` to the page as the file has it and writes
   * it in one store step (no save of Isaac's lands in between), unless the run stopped being the
   * agent's meanwhile: checked as the edit applies and again as the file is replaced.
   */
  private async write<T>(
    slug: string,
    page: string,
    edit: (b: CanvasBoard) => { board: CanvasBoard; value: T },
  ): Promise<T> {
    this.stillMine(slug)
    await this.call({ op: 'flush', slug })
    const r = await this.deps.store.update(slug, page, edit, () => this.stillMine(slug))
    if (r.saved) this.deps.changed(slug)
    this.runs.touch(slug)
    return r.value
  }

  // Agent actions --------------------------------------------------------------------------------

  async open(p: {
    slug?: string | undefined
    title?: string | undefined
    page?: string | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    let slug = p.slug
    if (slug === undefined) {
      slug = (await this.deps.store.create()).slug
      if (p.title !== undefined) await this.deps.store.rename(slug, p.title)
    }
    const board = slug
    return this.serial(board, async () => {
      const at = await this.begin(board, p.page, p.scope, p.caption)
      this.auto(board, `Opening ${at.board}`)
      await this.deps.show(board, p.scope)
      // The board comes up on its first page; it switches to the run's page if that is another.
      const now = this.deps.now ?? Date.now
      const deadline = now() + MOUNT_WAIT_MS
      let mounted = false
      while (!mounted && now() < deadline) {
        this.stillMine(board)
        mounted = (await this.call({ op: 'page', slug: board, page: at.page })).mounted
        if (!mounted) await this.sleep(150)
      }
      const shown = await this.deps.store.load(board, at.page)
      this.runs.touch(board)
      return {
        slug: board,
        title: at.board,
        page: at.page,
        pages: shown.pages,
        mounted,
      }
    })
  }

  async read(slug: string, page: string | undefined): Promise<object> {
    const at = await this.page(slug, page)
    const shown = await this.deps.store.load(slug, at.page)
    const { threads } = await this.deps.store.threads(slug, at.page)
    const a = await this.call({ op: 'boxes', slug, page: at.page })
    const boxes = boxesOf(at.b.nodes, a.mounted ? (a.boxes ?? null) : null)
    return {
      slug,
      title: at.board,
      page: at.page,
      pages: shown.pages,
      mounted: a.mounted,
      ...readout(at.b, boxes),
      threads: threads
        .filter((t) => !t.resolved)
        .map((t) => ({
          id: t.id,
          ...(t.node === undefined ? {} : { node: t.node }),
          first: t.messages[0]?.text ?? '',
          ...(t.messages.length > 1 ? { last: t.messages.at(-1)!.text } : {}),
          messages: t.messages.length,
        })),
      ...(this.shown.has(slug) ? { run: this.shown.get(slug)!.status } : {}),
    }
  }

  async add(p: {
    slug: string
    page?: string | undefined
    type?: CanvasNodeKind | undefined
    title?: string | undefined
    body?: string | undefined
    data?: CanvasNodeData | undefined
    x?: number | undefined
    y?: number | undefined
    w?: number | undefined
    h?: number | undefined
    near?: string | undefined
    parent?: string | undefined
    from?: string | undefined
    label?: string | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      const type = p.type ?? 'note'
      const data: CanvasNodeData = {
        ...p.data,
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.body === undefined ? {} : { body: p.body }),
      }
      // Unknown cards fail before the cursor moves.
      for (const ref of [p.near, p.from, p.parent]) if (ref !== undefined) nodeOf(at.b, ref)
      const label = data.title ?? data.body ?? type
      this.auto(p.slug, `Adding ${quote(label)}`)
      const boxes = await this.boxes(p.slug, at.page, at.b)
      const typical = typicalSize(type)
      const size = { w: p.w ?? typical.w, h: p.h ?? typical.h }
      const spot =
        p.x !== undefined && p.y !== undefined
          ? { x: p.x, y: p.y }
          : placeNew(at.b, boxes, size, { near: p.near, from: p.from, parent: p.parent })
      // A card placed in its frame grows the frame around it in the same write.
      const frame = p.parent === undefined ? undefined : boxes.get(p.parent)
      const grown = spot && frame ? grownFrame(frame, { ...spot, ...size }) : null
      const context = [p.from, p.near, p.parent].filter((id) => id !== undefined)
      if (spot) {
        await this.reveal(p.slug, at.page, {
          box: { ...spot, ...size },
          ...(context.length ? { context } : {}),
        })
        const tip = { x: spot.x + INSET, y: spot.y + INSET }
        if (await this.cursor(p.slug, at.page, { op: 'move', at: tip })) {
          await this.cursor(p.slug, at.page, { op: 'click', at: tip })
        }
      } else if (p.parent !== undefined) {
        await this.reveal(p.slug, at.page, { nodes: [p.parent] })
        await this.cursor(p.slug, at.page, { op: 'move', node: p.parent })
      }
      const made = await this.write<{ id: string; link?: string }>(p.slug, at.page, (b) => {
        const r = addCard(b, {
          type,
          data,
          ...(spot ? { at: spot } : {}),
          ...(p.w === undefined ? {} : { w: p.w }),
          ...(p.h === undefined ? {} : { h: p.h }),
          ...(p.parent === undefined ? {} : { parent: p.parent }),
        })
        let board = r.board
        if (grown && p.parent !== undefined)
          board = editCard(board, p.parent, { data: {}, ...grown })
        if (p.from === undefined) return { board, value: { id: r.id } }
        const c = connectCards(board, p.from, r.id, p.label ? { label: p.label } : {})
        return { board: c.board, value: { id: r.id, link: c.id } }
      })
      return { ...made, ...(spot ? { x: spot.x, y: spot.y } : {}), page: at.page }
    })
  }

  async edit(p: {
    slug: string
    page?: string | undefined
    node: string
    title?: string | undefined
    body?: string | undefined
    data?: CanvasNodeData | undefined
    type?: CanvasNodeKind | undefined
    w?: number | undefined
    h?: number | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      const card = nodeOf(at.b, p.node)
      this.auto(p.slug, `Editing ${quote(card.data?.title ?? card.id)}`)
      await this.reveal(p.slug, at.page, { nodes: [p.node] })
      if (await this.cursor(p.slug, at.page, { op: 'move', node: p.node })) {
        await this.cursor(p.slug, at.page, { op: 'click', node: p.node })
      }
      await this.write(p.slug, at.page, (b) => ({
        board: editCard(b, p.node, {
          data: {
            ...p.data,
            ...(p.title === undefined ? {} : { title: p.title }),
            ...(p.body === undefined ? {} : { body: p.body }),
          },
          ...(p.type === undefined ? {} : { type: p.type }),
          ...(p.w === undefined ? {} : { w: p.w }),
          ...(p.h === undefined ? {} : { h: p.h }),
        }),
        value: null,
      }))
      return { id: p.node }
    })
  }

  async move(p: {
    slug: string
    page?: string | undefined
    node: string
    x?: number | undefined
    y?: number | undefined
    near?: string | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      const card = nodeOf(at.b, p.node)
      this.auto(p.slug, `Moving ${quote(card.data?.title ?? card.id)}`)
      const boxes = await this.boxes(p.slug, at.page, at.b)
      const own = boxes.get(p.node) ?? { x: 0, y: 0, w: 240, h: 120 }
      let to: { x: number; y: number }
      if (p.near !== undefined) {
        nodeOf(at.b, p.near)
        const others = new Map([...boxes].filter(([id]) => id !== p.node))
        to = placeNew(at.b, others, { w: own.w, h: own.h }, { near: p.near }) ?? own
      } else {
        to = { x: p.x!, y: p.y! }
      }
      // The card with its new spot when both fit readably, else the card; a spot out of view
      // comes in during the carry (the board pans with it), so card and cursor stay on screen.
      const spot = { ...to, w: own.w, h: own.h }
      await this.reveal(p.slug, at.page, { nodes: [p.node], around: spot })
      if (await this.cursor(p.slug, at.page, { op: 'move', node: p.node, anchor: 'top' })) {
        await this.cursor(p.slug, at.page, { op: 'click', node: p.node, anchor: 'top' })
        this.stillMine(p.slug)
        const d = await this.call({
          op: 'drag',
          slug: p.slug,
          page: at.page,
          node: p.node,
          to,
          ms: DRAG_MS,
        })
        if (d.mounted) await this.sleep(d.ms ?? DRAG_MS)
      }
      await this.write(p.slug, at.page, (b) => ({ board: moveCard(b, p.node, to), value: null }))
      // The move is in the file: a later hide (done, Take over) leaves the card where it is.
      await this.call({ op: 'landed', slug: p.slug, page: at.page, node: p.node })
      return { id: p.node, x: Math.round(to.x), y: Math.round(to.y) }
    })
  }

  async connect(p: {
    slug: string
    page?: string | undefined
    from: string
    to: string
    label?: string | undefined
    tone?: 'accent' | 'proposed' | 'loop' | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      const a = nodeOf(at.b, p.from)
      const b = nodeOf(at.b, p.to)
      this.auto(
        p.slug,
        `Linking ${quote(a.data?.title ?? a.id)} to ${quote(b.data?.title ?? b.id)}`,
      )
      // Both cards when they fit readably, else the first now and the second before the cursor goes.
      await this.reveal(p.slug, at.page, { nodes: [p.from], context: [p.to] })
      if (await this.cursor(p.slug, at.page, { op: 'move', node: p.from, anchor: 'right' })) {
        await this.cursor(p.slug, at.page, { op: 'click', node: p.from, anchor: 'right' })
        await this.reveal(p.slug, at.page, { nodes: [p.to], context: [p.from] })
        await this.cursor(p.slug, at.page, { op: 'move', node: p.to, anchor: 'left' })
        await this.cursor(p.slug, at.page, { op: 'click', node: p.to, anchor: 'left' })
      }
      const r = await this.write(p.slug, at.page, (board) => {
        const c = connectCards(board, p.from, p.to, {
          ...(p.label === undefined ? {} : { label: p.label }),
          ...(p.tone === undefined ? {} : { tone: p.tone }),
        })
        return { board: c.board, value: { id: c.id, existed: c.existed } }
      })
      return r
    })
  }

  /**
   * Glides cards to their new absolute top lefts `to` on the board on screen as one undo step,
   * with what they leave and where they go (`whole`: the whole board) in view and the cursor on
   * the first; then writes `edit` and lands them, so a later hide leaves them where they are.
   */
  private async glide(
    slug: string,
    page: string,
    boxes: ReadonlyMap<string, Box>,
    to: ReadonlyMap<string, { x: number; y: number }>,
    whole: boolean,
    edit: (b: CanvasBoard) => CanvasBoard,
  ): Promise<void> {
    const first = to.keys().next().value
    const spots = [...to].flatMap(([id, at]) => {
      const box = boxes.get(id)
      return box ? [box, { ...box, ...at }] : []
    })
    const view = union(whole ? [...boxes.values(), ...spots] : spots)
    if (view) await this.reveal(slug, page, { box: view })
    if (
      first !== undefined &&
      (await this.cursor(slug, page, { op: 'move', node: first, anchor: 'top' }))
    ) {
      await this.cursor(slug, page, { op: 'click', node: first, anchor: 'top' })
      this.stillMine(slug)
      const a = await this.call({
        op: 'arrange',
        slug,
        page,
        to: Object.fromEntries(to),
        ms: ARRANGE_MS,
      })
      if (a.mounted) await this.sleep(a.ms ?? ARRANGE_MS)
    }
    await this.write(slug, page, (b) => ({ board: edit(b), value: null }))
    // Landing one card of the glide lands all of it on every mounted board of the slug.
    if (first !== undefined) await this.call({ op: 'landed', slug, page, node: first })
  }

  async layout(p: {
    slug: string
    page?: string | undefined
    algorithm?: LayoutAlgorithm | undefined
    direction?: LayoutDirection | undefined
    spacing?: number | undefined
    columns?: number | undefined
    keepPinned?: boolean | undefined
    frame?: string | undefined
    nodes?: string[] | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      let only: Set<string> | null = null
      if (p.frame !== undefined) {
        const frame = nodeOf(at.b, p.frame)
        if (frame.type !== 'frame') {
          fail('invalid-params', `${p.frame} is not a frame; give its cards as nodes`)
        }
        only = descendantsOf(at.b, p.frame)
        if (only.size === 0) fail('invalid-params', `Frame ${p.frame} has no cards in it`)
        this.auto(p.slug, `Laying out ${quote(frame.data?.title ?? frame.id)}`)
      } else if (p.nodes !== undefined) {
        for (const id of p.nodes) nodeOf(at.b, id)
        only = new Set(p.nodes)
        this.auto(
          p.slug,
          `Laying out ${p.nodes.length === 1 ? '1 card' : `${p.nodes.length} cards`}`,
        )
      } else this.auto(p.slug, 'Laying out the board')
      const boxes = await this.boxes(p.slug, at.page, at.b)
      const graph = layoutGraph(at.b, boxes)
      const algorithm = p.algorithm ?? 'layered'
      const laid = await layoutBoard(graph.nodes, graph.edges, {
        algorithm,
        direction: p.direction ?? 'right',
        spacing: p.spacing ?? SPACING,
        ...(p.columns === undefined ? {} : { columns: p.columns }),
        keepPinned: p.keepPinned ?? true,
        only,
      })
      const to = moves(laid.positions, boxes)
      await this.glide(p.slug, at.page, boxes, to, only === null, (b) =>
        arrangeCards(b, laid.positions, laid.frameSizes, laid.edges),
      )
      return { moved: to.size, kept: laid.kept, algorithm, routed: laid.edges.size }
    })
  }

  async align(p: {
    slug: string
    page?: string | undefined
    nodes: string[]
    to: AlignTo
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.lineUp(p, `Aligning ${p.nodes.length} cards`, (boxes) =>
      alignNodes(boxes, p.nodes, p.to),
    )
  }

  async distribute(p: {
    slug: string
    page?: string | undefined
    nodes: string[]
    axis: 'horizontal' | 'vertical'
    gap?: number | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.lineUp(p, `Spreading ${p.nodes.length} cards`, (boxes) =>
      distributeNodes(boxes, p.nodes, p.axis, p.gap),
    )
  }

  /**
   * Align and distribute: cards `nodes` (all on the board itself or all in one frame, each placed)
   * glide to where `place` puts them from their drawn boxes, a frame's cards along with it.
   */
  private lineUp(
    p: {
      slug: string
      page?: string | undefined
      nodes: string[]
      caption?: string | undefined
      scope?: string | undefined
    },
    caption: string,
    place: (boxes: ReadonlyMap<string, Box>) => Map<string, { x: number; y: number }>,
  ): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      const parents = new Set(p.nodes.map((id) => nodeOf(at.b, id).parent))
      if (parents.size > 1) {
        fail('invalid-params', 'Give cards that sit on the board itself, or all in one frame')
      }
      this.auto(p.slug, caption)
      const boxes = await this.boxes(p.slug, at.page, at.b)
      const unplaced = p.nodes.find((id) => !boxes.has(id))
      if (unplaced !== undefined) {
        fail('invalid-params', `Card ${unplaced} has no place yet; canvas.layout places it`)
      }
      const to = moves(withFrameChildren(at.b, boxes, place(boxes)), boxes)
      await this.glide(p.slug, at.page, boxes, to, false, (b) => arrangeCards(b, to))
      return {
        moved: to.size,
        nodes: Object.fromEntries(p.nodes.map((id) => [id, to.get(id) ?? rounded(boxes.get(id)!)])),
      }
    })
  }

  async remove(p: {
    slug: string
    page?: string | undefined
    nodes?: string[] | undefined
    edges?: string[] | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      const nodes = p.nodes ?? []
      const edges = p.edges ?? []
      // Unknown ids fail before the cursor moves.
      removeItems(at.b, nodes, edges)
      this.auto(
        p.slug,
        nodes.length === 1
          ? `Removing ${quote(nodeOf(at.b, nodes[0]!).data?.title ?? nodes[0]!)}`
          : 'Removing cards',
      )
      for (const id of nodes) {
        await this.reveal(p.slug, at.page, { nodes: [id], context: nodes })
        if (!(await this.cursor(p.slug, at.page, { op: 'move', node: id }))) break
        await this.cursor(p.slug, at.page, { op: 'click', node: id })
      }
      return this.write(p.slug, at.page, (b) => {
        const r = removeItems(b, nodes, edges)
        return { board: r.board, value: { deleted: { nodes: r.nodes, edges: r.edges } } }
      })
    })
  }

  async select(p: {
    slug: string
    page?: string | undefined
    ids: string[]
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      for (const id of p.ids) nodeOf(at.b, id)
      if (p.ids[0] !== undefined) {
        await this.reveal(p.slug, at.page, { nodes: [p.ids[0]], context: p.ids })
        await this.cursor(p.slug, at.page, { op: 'move', node: p.ids[0] })
      }
      this.stillMine(p.slug)
      const a = await this.call({ op: 'select', slug: p.slug, page: at.page, ids: p.ids })
      this.runs.touch(p.slug)
      return { selected: p.ids, mounted: a.mounted }
    })
  }

  async view(p: {
    slug: string
    page?: string | undefined
    zoom?: number | undefined
    fit?: boolean | undefined
    node?: string | undefined
    dx?: number | undefined
    dy?: number | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      let center: { x: number; y: number } | undefined
      if (p.node !== undefined) {
        nodeOf(at.b, p.node)
        const box = (await this.boxes(p.slug, at.page, at.b)).get(p.node)
        if (box) center = { x: box.x + box.w / 2, y: box.y + box.h / 2 }
      }
      const pan =
        p.dx !== undefined || p.dy !== undefined ? { dx: p.dx ?? 0, dy: p.dy ?? 0 } : undefined
      this.stillMine(p.slug)
      const a = await this.call({
        op: 'view',
        slug: p.slug,
        page: at.page,
        ...(p.zoom === undefined ? {} : { zoom: p.zoom }),
        ...(p.fit ? { fit: true } : {}),
        ...(center ? { center } : {}),
        ...(pan ? { pan } : {}),
        duration: 450,
      })
      if (a.mounted) await this.sleep(450)
      this.runs.touch(p.slug)
      return { mounted: a.mounted, ...(a.viewport ? { viewport: a.viewport } : {}) }
    })
  }

  async reply(p: {
    slug: string
    page?: string | undefined
    thread: string
    text: string
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, undefined)
      const { threads } = await this.deps.store.threads(p.slug, at.page)
      const t =
        threads.find((x) => x.id === p.thread) ??
        fail('not-found', `No comment thread ${p.thread} on this page; canvas.read lists them`)
      this.auto(p.slug, 'Replying to a comment')
      // A pin on a card sits at an offset from the card's top left; the cursor goes to the card. A
      // pin on the board shows with a little room around it.
      await this.reveal(
        p.slug,
        at.page,
        t.node === undefined
          ? { box: { x: t.x - PIN_ROOM, y: t.y - PIN_ROOM, w: PIN_ROOM * 2, h: PIN_ROOM * 2 } }
          : { nodes: [t.node] },
      )
      await this.cursor(
        p.slug,
        at.page,
        t.node === undefined
          ? { op: 'move', at: { x: t.x, y: t.y } }
          : { op: 'move', node: t.node },
      )
      await this.deps.store.threads(
        p.slug,
        at.page,
        { op: 'post', thread: p.thread, text: p.text },
        { name: at.who.name, color: at.who.color },
        () => this.stillMine(p.slug),
      )
      this.deps.changed(p.slug)
      this.runs.touch(p.slug)
      return { thread: p.thread, posted: true }
    })
  }

  async caption(slug: string, text: string, scope: string | undefined): Promise<object> {
    return this.serial(slug, async () => {
      await this.begin(slug, undefined, scope, text)
      return { caption: text }
    })
  }

  async done(
    slug: string,
    summary: string,
    outcome: 'done' | 'stopped' = 'done',
    scope: string | undefined,
  ): Promise<object> {
    return this.serial(slug, async () => {
      const who = await this.deps.identify(scope)
      const at = await this.page(slug, undefined)
      this.runs.finish(slug, who, summary, outcome)
      this.where.set(slug, { board: at.board, page: at.page })
      return { status: outcome }
    })
  }

  async wait(
    slug: string,
    timeoutMs = 30_000,
  ): Promise<{ met: boolean; status: AgentRunStatus | null }> {
    const met = await this.runs.waitHandback(slug, timeoutMs)
    return { met, status: this.runs.view(slug)?.status ?? null }
  }
}

const quote = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return `"${one.length > 40 ? `${one.slice(0, 39)}…` : one}"`
}

const rounded = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: Math.round(p.x),
  y: Math.round(p.y),
})

/** The cards of `to` (rounded like the file) that land somewhere else than their `boxes`. */
function moves(
  to: ReadonlyMap<string, { x: number; y: number }>,
  boxes: ReadonlyMap<string, Box>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  for (const [id, p] of to) {
    const at = rounded(p)
    const box = boxes.get(id)
    if (!box || Math.abs(box.x - at.x) >= 0.5 || Math.abs(box.y - at.y) >= 0.5) out.set(id, at)
  }
  return out
}

/** The smallest box around `boxes`; null for none. */
function union(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const bottom = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: r - x, h: bottom - y }
}
