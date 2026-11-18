import type {
  AgentRunOp,
  AgentRunStatus,
  CanvasBoard,
  CanvasBoardAnswer,
  CanvasBoardCall,
  CanvasCursorOp,
  CanvasNodeData,
  CanvasNodeKind,
  CardEdit,
  CardVariant,
  CanvasRun,
} from '@evaos/contract'
import { protoSourceRefusal } from '@relay/widget-runtime/proto'
import { frameRefusal, isDesignSystem } from '@relay/widget-runtime/systems'
import { AgentRuns, fail } from '../agent-presence/agent-runs'
import type { DriveIdentity } from '../browser/agent-drive'
import { alignNodes, distributeNodes, layoutBoard } from '../../shared/canvas-layout'
import type { AlignTo, LayoutAlgorithm, LayoutDirection } from '../../shared/canvas-layout/types'
import {
  GAP,
  addCard,
  arrangeCards,
  boxesOf,
  connectCards,
  descendantsOf,
  editCard,
  freshGroup,
  grownFrame,
  layoutGraph,
  moveCard,
  nextVariantLabel,
  nodeOf,
  patchBody,
  placeNew,
  placeRow,
  readout,
  removeItems,
  typicalSize,
  withFrameChildren,
  type Box,
} from './board-edit'
import { protoCardSize } from '../../shared/proto-card'
import type { CanvasStore } from './store'

/** Fails before anything moves when a component card's frame is missing or not one. */
function checkFrame(frame: string | undefined): void {
  const why = frameRefusal(frame)
  if (why !== null) fail('invalid-params', why)
}

/**
 * What canvas.add and canvas.edit answer about a component card's code: `ok`, or why it does not
 * compile in its design system (the card keeps its last good render). Undefined for other cards.
 */
function compileOf(type: CanvasNodeKind, data: CanvasNodeData | undefined): string | undefined {
  if (type !== 'proto') return undefined
  const system = isDesignSystem(data?.system) ? data.system : 'mantine'
  return protoSourceRefusal(data?.body ?? '', system) ?? 'ok'
}

/**
 * A chat's agent working a board in front of Isaac (the canvas.* agent actions), like the browser
 * drive works a page: one run per board (AgentRuns: ring, caption, Take over / Hand back), the
 * agent's cursor travelling to each change on the board on screen before it lands, and every
 * change written to `<slug>.json` through the board store, which the open board reloads at once.
 * The board on screen answers the `@canvas` calls (CanvasBoardCall); a board that is not on screen
 * still gets every change, without the cursor (docs/agent-presence.md).
 *
 * Isaac looking around never stops the agent: panning, zooming, selecting, commenting and Pick
 * change nothing here. Only Take over pauses the run. His own changes to cards (`hold`) lock just
 * those cards for a moment: an agent change to one answers `locked-by-isaac` at once, every other
 * change lands. No action outlives ANSWER_MS: what cannot finish answers why instead of hanging.
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
  /** Test seams for ANSWER_MS and BOARD_CALL_MS. */
  answerMs?: number
  boardCallMs?: number
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
/** Isaac's hold on a card lasts this long after his last change to it. */
export const HOLD_IDLE_MS = 3_000
/**
 * The longest an action (with its wait behind the board's earlier ones) runs before it answers:
 * well inside an MCP call's 60 s. Past it the action answers `timeout` and lands nothing more.
 */
export const ANSWER_MS = 30_000
/** The longest one call to the board on screen may take; past it the board counts as not shown. */
export const BOARD_CALL_MS = 5_000
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

/** The action in flight on a board: the run epoch it began in, and whether it ran out of time. */
interface Turn {
  epoch: number
  late: boolean
}

export class CanvasDrive {
  private readonly runs: AgentRuns<string, DriveIdentity>
  private readonly shown = new Map<string, CanvasRun>()
  private readonly where = new Map<string, Where>()
  /** Each board's action in flight (one action per board at a time). */
  private readonly acting = new Map<string, Turn>()
  /** The cards Isaac is changing on each board, until when (HOLD_IDLE_MS after his last change). */
  private readonly held = new Map<string, Map<string, number>>()
  private readonly now: () => number
  /** Each board's actions, one after another. */
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: CanvasDriveDeps) {
    const now = deps.now ?? Date.now
    this.now = now
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

  /**
   * Isaac is changing `nodes` on the board (a drag, a resize, a delete, an undo): an agent change
   * to one of them answers `locked-by-isaac` until HOLD_IDLE_MS after his last change. The run
   * keeps working; every other card stays the agent's to change.
   */
  hold(slug: string, nodes: readonly string[]): void {
    const until = this.now() + HOLD_IDLE_MS
    const cards = this.held.get(slug) ?? new Map<string, number>()
    for (const [id, end] of cards) if (end <= this.now()) cards.delete(id)
    for (const id of nodes) cards.set(id, until)
    if (cards.size > 0) this.held.set(slug, cards)
    else this.held.delete(slug)
  }

  /** Fails `locked-by-isaac`, at once, when Isaac is changing any of `nodes` now. */
  private free(slug: string, nodes: Iterable<string>): void {
    const cards = this.held.get(slug)
    if (!cards) return
    const now = this.now()
    const busy: string[] = []
    let wait = 0
    for (const id of new Set(nodes)) {
      const end = cards.get(id)
      if (end === undefined || end <= now) continue
      busy.push(id)
      wait = Math.max(wait, end - now)
    }
    if (busy.length === 0) return
    const which = busy.length === 1 ? `card ${busy[0]}` : `cards ${busy.join(', ')}`
    fail(
      'locked-by-isaac',
      `Card locked by Isaac: he is changing ${which} right now, so nothing landed. Work on other ` +
        `cards, or try again in about ${Math.ceil(wait / 1000)} s (canvas.read first: he may have moved it)`,
    )
  }

  // Board on screen ------------------------------------------------------------------------------

  /** One call to the board on screen; a board that errs or takes over BOARD_CALL_MS is not shown. */
  private async call(c: CanvasBoardCall): Promise<CanvasBoardAnswer> {
    const missing: CanvasBoardAnswer = { mounted: false, ms: 0 }
    try {
      return (await within(this.deps.board(c), this.deps.boardCallMs ?? BOARD_CALL_MS)) ?? missing
    } catch {
      return missing
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
   * The action in flight may go on: its run is still working in the epoch it began in, and it has
   * not run out of time. Isaac taking over (or the run ending, or ANSWER_MS passing) since then
   * stops it before anything more lands.
   */
  private stillMine(slug: string): void {
    const turn = this.acting.get(slug)
    if (turn?.late) {
      fail('timeout', 'This action ran out of time and was answered; nothing more landed')
    }
    const status = this.runs.view(slug)?.status
    if (status === 'paused') {
      fail('paused-by-isaac', 'Isaac took over this board. canvas.wait until handback')
    }
    if (status !== 'working' || this.runs.epoch(slug) !== turn?.epoch) {
      fail('stopped', 'This run on the board ended while the action ran; nothing more landed')
    }
  }

  /**
   * Runs `act` once the board's earlier actions are through, so their steps never interleave, and
   * answers within ANSWER_MS whatever happens: `busy` when the earlier ones still run (this one
   * then never runs), `timeout` when this one is too slow (it lands nothing more).
   */
  private async serial<T extends object>(slug: string, act: () => Promise<T>): Promise<T> {
    const turn: Turn = { epoch: -1, late: false }
    let started = false
    const go = (): Promise<T> => {
      if (turn.late) return Promise.reject(new Error('answered already'))
      started = true
      this.acting.set(slug, turn)
      return act()
    }
    const run = (this.queues.get(slug) ?? Promise.resolve()).then(go, go)
    const tail = run.catch(() => {})
    this.queues.set(slug, tail)
    void tail.then(() => {
      if (this.queues.get(slug) === tail) this.queues.delete(slug)
    })
    const ms = this.deps.answerMs ?? ANSWER_MS
    const value = await within(run, ms)
    if (value !== undefined) return value
    turn.late = true
    const secs = Math.round(ms / 1000)
    return started
      ? fail(
          'timeout',
          `The board did not finish this in ${secs} s (its file or the app page is slow); nothing ` +
            'more lands. canvas.read to see what is there before trying again',
        )
      : fail(
          'busy',
          `An earlier action on this board is still running after ${secs} s; this one did not ` +
            'run. Try again in a moment',
        )
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
    this.acting.get(slug)!.epoch = this.runs.epoch(slug)
    return { ...at, who }
  }

  private auto(slug: string, text: string): void {
    this.runs.caption(slug, text, true)
  }

  /**
   * Saves the board's pending edits, then applies `edit` to the page as the file has it and writes
   * it in one store step (no save of Isaac's lands in between), unless the run stopped being the
   * agent's or Isaac took hold of one of the `cards` it changes meanwhile: checked as the edit
   * applies and again as the file is replaced.
   */
  private async write<T>(
    slug: string,
    page: string,
    edit: (b: CanvasBoard) => { board: CanvasBoard; value: T },
    cards: readonly string[] = [],
  ): Promise<T> {
    const mine = (): void => {
      this.stillMine(slug)
      this.free(slug, cards)
    }
    mine()
    await this.call({ op: 'flush', slug })
    const r = await this.deps.store.update(slug, page, edit, mine)
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

  /** canvas.read; answers `timeout` rather than outliving ANSWER_MS. */
  async read(slug: string, page: string | undefined): Promise<object> {
    const ms = this.deps.answerMs ?? ANSWER_MS
    const shown = await within(this.readNow(slug, page), ms)
    return (
      shown ??
      fail(
        'timeout',
        `The board did not answer in ${Math.round(ms / 1000)} s; try again in a moment`,
      )
    )
  }

  private async readNow(slug: string, page: string | undefined): Promise<object> {
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
      ...(a.mounted ? { selected: a.selected ?? [] } : {}),
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
    copy?: string | undefined
    edits?: CardEdit[] | undefined
    variants?: CardVariant[] | undefined
    caption?: string | undefined
    scope?: string | undefined
  }): Promise<object> {
    return this.serial(p.slug, async () => {
      const at = await this.begin(p.slug, p.page, p.scope, p.caption)
      // Unknown cards and patches that do not apply fail before the cursor moves.
      for (const ref of [p.near, p.from, p.parent, p.copy]) if (ref !== undefined) nodeOf(at.b, ref)
      const base = p.copy === undefined ? undefined : nodeOf(at.b, p.copy)
      const type = p.type ?? base?.type ?? (p.variants ? 'proto' : 'note')
      const { variant: _v, group: _g, ...baseData } = base?.data ?? {}
      const data: CanvasNodeData = {
        ...baseData,
        ...p.data,
        ...(p.title === undefined ? {} : { title: p.title }),
        ...(p.body === undefined ? {} : { body: p.body }),
      }
      if (p.edits) data.body = patchBody(data.body ?? '', p.edits)
      if (type === 'proto' && data.system === undefined) data.system = 'relay'
      // A copy is a one-card variant set with the card it copies.
      const variants = p.variants ?? (base ? [{}] : null)
      const group = variants === null ? undefined : (base?.data?.group ?? freshGroup(at.b))
      const baseLabel = base && group !== undefined ? (base.data?.variant ?? 'A') : undefined
      const taken: string[] = baseLabel === undefined ? [] : [baseLabel]
      const cards: CanvasNodeData[] =
        variants === null || group === undefined
          ? [data]
          : variants.map((v) => {
              const variant = v.label ?? nextVariantLabel(at.b, group, taken)
              taken.push(variant)
              return {
                ...data,
                ...v.data,
                ...(v.title === undefined ? {} : { title: v.title }),
                body: v.body ?? (v.edits ? patchBody(data.body ?? '', v.edits) : data.body),
                variant,
                group,
              }
            })
      // A component card is drawn at the real size of the surface it is for: it names a frame.
      if (type === 'proto') for (const d of cards) checkFrame(d.frame)
      const label = data.title ?? data.body ?? type
      this.auto(
        p.slug,
        cards.length > 1
          ? `Adding ${cards.length} variants of ${quote(label)}`
          : `Adding ${quote(label)}`,
      )
      const boxes = await this.boxes(p.slug, at.page, at.b)
      const typical = typicalSize(type)
      // A component card's size is its frame's (the row is as big as its biggest frame).
      const framed = type === 'proto' ? cards.map((d) => protoCardSize(d.frame)) : []
      const size =
        framed.length > 0
          ? { w: Math.max(...framed.map((s) => s.w)), h: Math.max(...framed.map((s) => s.h)) }
          : { w: p.w ?? base?.w ?? typical.w, h: p.h ?? base?.h ?? typical.h }
      const spots =
        p.x !== undefined && p.y !== undefined
          ? cards.map((_, i) => ({ x: p.x! + i * (size.w + GAP), y: p.y! }))
          : placeRow(at.b, boxes, size, cards.length, {
              near: p.near ?? p.copy,
              from: p.from,
              parent: p.parent,
            })
      const row = spots
        ? { ...spots[0]!, w: cards.length * size.w + (cards.length - 1) * GAP, h: size.h }
        : null
      // Cards placed in their frame grow the frame around them in the same write.
      const frame = p.parent === undefined ? undefined : boxes.get(p.parent)
      const grown = row && frame ? grownFrame(frame, row) : null
      const context = [p.from, p.near, p.parent, p.copy].filter((id) => id !== undefined)
      // The cards this add changes besides the new ones: the copied card (it becomes variant A)
      // and a frame it grows. Isaac holding one answers at once, before the cursor moves.
      const changes = [
        ...(base ? [base.id] : []),
        ...(grown && p.parent !== undefined ? [p.parent] : []),
      ]
      this.free(p.slug, changes)
      const tip = (s: { x: number; y: number }) => ({ x: s.x + INSET, y: s.y + INSET })
      if (spots && row) {
        await this.reveal(p.slug, at.page, { box: row, ...(context.length ? { context } : {}) })
        if (await this.cursor(p.slug, at.page, { op: 'move', at: tip(spots[0]!) })) {
          await this.cursor(p.slug, at.page, { op: 'click', at: tip(spots[0]!) })
        }
      } else if (p.parent !== undefined) {
        await this.reveal(p.slug, at.page, { nodes: [p.parent] })
        await this.cursor(p.slug, at.page, { op: 'move', node: p.parent })
      }
      const made = await this.write<{ ids: string[]; link?: string }>(
        p.slug,
        at.page,
        (b) => {
          let board = b
          if (base && group !== undefined && baseLabel !== undefined) {
            board = editCard(board, base.id, { data: { group, variant: baseLabel } })
          }
          const ids: string[] = []
          cards.forEach((d, i) => {
            const spot = spots?.[i]
            const r = addCard(board, {
              type,
              data: d,
              ...(spot ? { at: spot } : {}),
              ...(p.w === undefined ? {} : { w: p.w }),
              ...(p.h === undefined ? {} : { h: p.h }),
              ...(p.parent === undefined ? {} : { parent: p.parent }),
            })
            board = r.board
            ids.push(r.id)
          })
          if (grown && p.parent !== undefined)
            board = editCard(board, p.parent, { data: {}, ...grown })
          if (p.from === undefined) return { board, value: { ids } }
          const c = connectCards(board, p.from, ids[0]!, p.label ? { label: p.label } : {})
          return { board: c.board, value: { ids, link: c.id } }
        },
        changes,
      )
      // The cursor visits each sibling as it lands (the first one it clicked into place).
      for (const spot of spots?.slice(1) ?? []) {
        try {
          if (await this.cursor(p.slug, at.page, { op: 'move', at: tip(spot) })) {
            await this.cursor(p.slug, at.page, { op: 'click', at: tip(spot) })
          }
        } catch {
          // Isaac took over after the cards landed: they stay, the tour stops.
          break
        }
      }
      const compiled = cards.map((d) => compileOf(type, d))
      if (p.variants) {
        return {
          ids: made.ids,
          group,
          labels: cards.map((d) => d.variant),
          ...(type === 'proto'
            ? { compile: Object.fromEntries(made.ids.map((id, i) => [id, compiled[i]])) }
            : {}),
          page: at.page,
        }
      }
      const id = made.ids[0]!
      return {
        id,
        ...(made.link === undefined ? {} : { link: made.link }),
        ...(spots ? { x: spots[0]!.x, y: spots[0]!.y } : {}),
        ...(group === undefined ? {} : { group, variant: cards[0]!.variant }),
        ...(compiled[0] === undefined ? {} : { compile: compiled[0] }),
        page: at.page,
      }
    })
  }

  async edit(p: {
    slug: string
    page?: string | undefined
    node: string
    title?: string | undefined
    body?: string | undefined
    edits?: CardEdit[] | undefined
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
      // A patch that does not apply, or a frame that is not one, fails before the cursor moves.
      if (p.edits) patchBody(card.data?.body ?? '', p.edits)
      if (p.data?.frame !== undefined) checkFrame(p.data.frame)
      this.free(p.slug, [p.node])
      this.auto(p.slug, `Editing ${quote(card.data?.title ?? card.id)}`)
      await this.reveal(p.slug, at.page, { nodes: [p.node] })
      if (await this.cursor(p.slug, at.page, { op: 'move', node: p.node })) {
        await this.cursor(p.slug, at.page, { op: 'click', node: p.node })
      }
      const edited = await this.write(
        p.slug,
        at.page,
        (b) => {
          // Patched against the file as it is now, not as it was read.
          const body = p.edits ? patchBody(nodeOf(b, p.node).data?.body ?? '', p.edits) : p.body
          const board = editCard(b, p.node, {
            data: {
              ...p.data,
              ...(p.title === undefined ? {} : { title: p.title }),
              ...(body === undefined ? {} : { body }),
            },
            ...(p.type === undefined ? {} : { type: p.type }),
            ...(p.w === undefined ? {} : { w: p.w }),
            ...(p.h === undefined ? {} : { h: p.h }),
          })
          return { board, value: nodeOf(board, p.node) }
        },
        [p.node],
      )
      const compile = compileOf(edited.type, edited.data)
      return { id: p.node, ...(compile === undefined ? {} : { compile }) }
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
      this.free(p.slug, [p.node])
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
      await this.write(p.slug, at.page, (b) => ({ board: moveCard(b, p.node, to), value: null }), [
        p.node,
      ])
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
    resized: readonly string[] = [],
  ): Promise<void> {
    // Every card that moves or grows; one Isaac holds answers at once, before the cursor moves.
    const cards = [...to.keys(), ...resized]
    this.free(slug, cards)
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
    await this.write(slug, page, (b) => ({ board: edit(b), value: null }), cards)
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
      await this.glide(
        p.slug,
        at.page,
        boxes,
        to,
        only === null,
        (b) => arrangeCards(b, laid.positions, laid.frameSizes, laid.edges),
        [...laid.frameSizes.keys()],
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
      this.free(p.slug, nodes)
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
      return this.write(
        p.slug,
        at.page,
        (b) => {
          const r = removeItems(b, nodes, edges)
          return { board: r.board, value: { deleted: { nodes: r.nodes, edges: r.edges } } }
        },
        nodes,
      )
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

/** What `p` resolves to, or undefined once `ms` pass first (`p` itself runs on). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  const late = Promise.withResolvers<undefined>()
  const timer = setTimeout(() => late.resolve(undefined), ms)
  try {
    return await Promise.race([p, late.promise])
  } finally {
    clearTimeout(timer)
  }
}
