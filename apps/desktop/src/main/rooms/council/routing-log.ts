import type { CouncilTurnKind } from '@relay/protocol'
import type { RoomSeat, RoutingEntry, RubricCriterion } from '@evaos/contract'

/** What a turn is for; the kind of a routing entry follows from it and the seat's role. */
export type TurnPurpose =
  | 'rubric'
  | 'contract'
  | 'paintover'
  | 'object'
  | 'plan'
  | 'build'
  | 'look'
  | 'integrate'
  | 'critique'
  | 'research'
  | 'score'
  | 'answer'
  | 'final'

/** The routing kind of one turn: from what it was for, what it made and what it changed. */
export function turnKind(
  seat: Pick<RoomSeat, 'role'>,
  purpose: TurnPurpose,
  made: { images: number; files: readonly string[] },
): CouncilTurnKind {
  if (made.images > 0 && (seat.role === 'director' || purpose === 'paintover')) return 'image'
  switch (purpose) {
    case 'rubric':
    case 'contract':
    case 'plan':
      return 'plan'
    case 'build':
      if (made.files.length === 0) return 'talk'
      return made.files.every((f) => f.endsWith('params.json')) ? 'params' : 'code'
    case 'look':
      return made.files.length === 0 ? 'talk' : 'params'
    case 'integrate':
      return 'merge'
    case 'critique':
      return 'critique'
    case 'research':
      return 'research'
    case 'score':
      return 'score'
    default:
      return 'talk'
  }
}

/** One seat's line in the deliverable's "Who did what". */
export interface WhoDid {
  seat: string
  turns: number
  usd: number
  /** Kinds in first-seen order: "code, merge". */
  kinds: CouncilTurnKind[]
  /** Criterion id -> summed score delta credited. */
  moved: Record<string, number>
}

/**
 * The room's routing log: one entry per seat turn, written whole to
 * `memory/rooms/<stem>.routing.jsonl` after every change (writes queue in order).
 */
export class RoutingLog {
  readonly entries: RoutingEntry[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly write: (content: string) => Promise<void>,
    private readonly log: (line: string) => void,
  ) {}

  add(e: RoutingEntry): Promise<void> {
    this.entries.push(e)
    return this.flush()
  }

  round(n: number): RoutingEntry[] {
    return this.entries.filter((e) => e.round === n)
  }

  /**
   * Credits a scorecard's deltas: each criterion's delta goes to the last entry of that round of
   * every seat `owners` names for it (the owner part's builder and look seat).
   */
  credit(
    round: number,
    deltas: Record<string, number>,
    rubric: readonly RubricCriterion[],
    owners: (c: RubricCriterion) => string[],
  ): Promise<void> {
    const entries = this.round(round)
    for (const c of rubric) {
      const d = deltas[c.id]
      if (d === undefined || d === 0) continue
      for (const seat of owners(c)) {
        const last = entries.findLast((e) => e.seat === seat)
        if (!last) continue
        last.criteria = { ...last.criteria, [c.id]: (last.criteria?.[c.id] ?? 0) + d }
      }
    }
    return this.flush()
  }

  /** Per seat, in first-turn order. */
  who(): WhoDid[] {
    const by = new Map<string, WhoDid>()
    for (const e of this.entries) {
      let w = by.get(e.seat)
      if (!w) {
        w = { seat: e.seat, turns: 0, usd: 0, kinds: [], moved: {} }
        by.set(e.seat, w)
      }
      w.turns += 1
      w.usd += e.usd
      if (!w.kinds.includes(e.kind)) w.kinds.push(e.kind)
      for (const [k, v] of Object.entries(e.criteria ?? {})) w.moved[k] = (w.moved[k] ?? 0) + v
    }
    return [...by.values()]
  }

  /** Settles once every write so far has landed. */
  settled(): Promise<void> {
    return this.writing
  }

  private flush(): Promise<void> {
    const body = this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    this.writing = this.writing
      .then(() => this.write(body))
      .catch((e: unknown) =>
        this.log(`routing log write failed: ${e instanceof Error ? e.message : String(e)}`),
      )
    return this.writing
  }
}
