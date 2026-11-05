import { describe, expect, it } from 'vitest'
import type { ThreadReactions } from './reactions'
import {
  ENGAGE_MS,
  PROACTIVE_GAP_MS,
  buildTurns as build,
  compressTicks,
  marked,
  stepTurn,
  tickAtY,
  turnAt,
  turnOfItem,
  visibleTurns,
  type Turn,
  type TurnRow,
} from './turns'

const T0 = 1_800_000_000_000
type Spec = Omit<TurnRow, 'index' | 'ref'>
const user = (id: string, text: string, at: number): Spec => ({ id, role: 'user', text, at })
const bot = (id: string, text: string, at: number, extra: Partial<Spec> = {}): Spec => ({
  id,
  role: 'assistant',
  text,
  at,
  ...extra,
})
const ask = (id: string): Spec => ({ id, role: 'ask', text: '' })
/** Rows in order, each at its own position. */
const buildTurns = (specs: Spec[], reactions: ThreadReactions | undefined): Turn[] =>
  build(
    specs.map((s, index) => ({ ...s, index, ref: {} })),
    reactions,
  )

describe('buildTurns', () => {
  it('makes one turn per user message with its title and the start of the reply', () => {
    const turns = buildTurns(
      [
        user('u1', 'Fix the **rail**', T0),
        bot('a1', 'Fixed it.\n\nMore detail below.', T0 + 1000),
        user('u2', 'Thanks', T0 + 2000),
        bot('a2', 'Anytime.', T0 + 3000),
      ],
      undefined,
    )
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({
      key: `user@${T0}`,
      row: 'u1',
      item: 0,
      led: 'user',
      title: 'Fix the rail',
      reply: 'Fixed it. More detail below.',
      flag: null,
    })
    expect(turns[1]).toMatchObject({ item: 2, title: 'Thanks', reply: 'Anytime.' })
  })

  it('starts a turn at an assistant that spoke first, and after a long silence', () => {
    const turns = buildTurns(
      [
        bot('a0', 'Morning report\nThe rail shipped overnight.', T0),
        user('u1', 'ok', T0 + 1000),
        bot('a1', 'Fine.', T0 + 2000),
        bot('a2', 'Heads up, the deploy is live.', T0 + 2000 + PROACTIVE_GAP_MS + 1),
      ],
      undefined,
    )
    expect(turns.map((t) => [t.led, t.title])).toEqual([
      ['assistant', 'Morning report'],
      ['user', 'ok'],
      ['assistant', 'Heads up, the deploy is live.'],
    ])
    expect(turns[0]!.reply).toBe('The rail shipped overnight.')
  })

  describe('flags', () => {
    it('flags a question not yet answered, and clears it once he answers', () => {
      const asked = [user('u1', 'ship?', T0), bot('a1', 'Tests pass. Push it?', T0 + 1)]
      expect(buildTurns(asked, undefined)[0]!.flag).toBe('ask')
      const answered = [...asked, user('u2', 'yes', T0 + 2), bot('a2', 'Pushed.', T0 + 3)]
      expect(buildTurns(answered, undefined)[0]!.flag).toBeNull()
    })

    it('flags tap-to-answer replies and an open ask card', () => {
      const chips = buildTurns(
        [user('u1', 'x', T0), bot('a1', 'Pick.\n[[replies: A | B]]', T0 + 1)],
        undefined,
      )
      expect(chips[0]!.flag).toBe('ask')
      expect(buildTurns([user('u1', 'x', T0), ask('t1')], undefined)[0]!.flag).toBe('ask')
      expect(
        buildTurns([user('u1', 'x', T0), ask('t1'), user('u2', 'ok', T0 + 1)], undefined)[0]!.flag,
      ).toBeNull()
    })

    it('flags a shipped announcement, a question winning over it', () => {
      const shipped = buildTurns(
        [user('u1', 'x', T0), bot('a1', 'The rail is live. Restart Relay.', T0 + 1)],
        undefined,
      )
      expect(shipped[0]!.flag).toBe('shipped')
      const both = buildTurns(
        [user('u1', 'x', T0), bot('a1', 'The rail is live. Want a tour?', T0 + 1)],
        undefined,
      )
      expect(both[0]!.flag).toBe('ask')
    })

    it("clears with Isaac's reaction on any bubble of the turn, not an assistant's", () => {
      const items = [user('u1', 'x', T0), bot('a1', 'Is it ok?', T0 + 1)]
      const mine: ThreadReactions = {
        [`assistant@${T0 + 1}`]: { isaac: { emoji: '👍', excerpt: 'Is it ok?', at: 1 } },
      }
      expect(buildTurns(items, mine)[0]!.flag).toBeNull()
      const theirs: ThreadReactions = {
        [`user@${T0}`]: { nova: { emoji: '👍', excerpt: 'x', at: 1 } },
      }
      expect(buildTurns(items, theirs)[0]!.flag).toBe('ask')
    })

    it('does not flag a reply still streaming', () => {
      const items = [user('u1', 'x', T0), bot('a1', 'Is it ok?', T0 + 1, { streaming: true })]
      expect(buildTurns(items, undefined)[0]!.flag).toBeNull()
    })

    it('answers an assistant-started turn by a soon message, a tapped reply or a quote, not by unrelated later chat', () => {
      const first = bot('a0', 'Deploy is live. Restart when ready?\n[[replies: Now | Later]]', T0)
      const solo = buildTurns([first], undefined)
      expect(solo[0]!.flag).toBe('ask')
      const soon = buildTurns([first, user('u1', 'whatever', T0 + ENGAGE_MS)], undefined)
      expect(soon[0]!.flag).toBeNull()
      const late = user('u1', 'unrelated thing', T0 + ENGAGE_MS + 1)
      expect(buildTurns([first, late], undefined)[0]!.flag).toBe('ask')
      const chip = user('u1', 'later', T0 + ENGAGE_MS * 5)
      expect(buildTurns([first, chip], undefined)[0]!.flag).toBeNull()
      const quote = user('u1', '> Deploy is live. Restart\n\nnow', T0 + ENGAGE_MS * 5)
      expect(buildTurns([first, quote], undefined)[0]!.flag).toBeNull()
    })
  })

  it('indexes thousands of turns quickly and keeps the item index', () => {
    const items: Spec[] = []
    for (let i = 0; i < 5000; i++) {
      items.push(user(`u${i}`, `Question ${i}`, T0 + i * 10))
      items.push(bot(`a${i}`, i % 50 === 0 ? 'Done. OK?' : 'Done.', T0 + i * 10 + 5))
    }
    const t = performance.now()
    const turns = buildTurns(items, undefined)
    expect(performance.now() - t).toBeLessThan(500)
    expect(turns).toHaveLength(5000)
    expect(turns[4999]!.item).toBe(9998)
    // Only the last turn can still be waiting among user-led ones answered by the next message.
    expect(turns.filter((x) => x.flag !== null).map((x) => x.title)).toEqual([])
  })
})

/** Turns at items 0, 2, 4, ... each 100 px tall. */
function fixture(n: number, flagAt: Record<number, Turn['flag']> = {}): Turn[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `user@${i}`,
    row: `u${i}`,
    item: i * 2,
    led: 'user' as const,
    title: `T${i}`,
    reply: '',
    flag: flagAt[i] ?? null,
  }))
}
const offsetOf = (item: number): number => (item / 2) * 100

describe('turnAt, visibleTurns and stepTurn', () => {
  const turns = fixture(10)
  it('finds the turn at the top edge', () => {
    expect(turnAt(turns, offsetOf, 0)).toBe(0)
    expect(turnAt(turns, offsetOf, 99)).toBe(0)
    expect(turnAt(turns, offsetOf, 100)).toBe(1)
    expect(turnAt(turns, offsetOf, 5000)).toBe(9)
  })
  it('lists the turns that start on screen, always with the active one', () => {
    expect(visibleTurns(turns, offsetOf, 150, 450, 1)).toEqual([1, 4])
    expect(visibleTurns(turns, offsetOf, 120, 180, 1)).toEqual([1, 1])
  })
  it('steps to the next turn, the start of the current one when partway, and stops at the ends', () => {
    expect(stepTurn(turns, offsetOf, 0, 1)).toBe(1)
    expect(stepTurn(turns, offsetOf, 100, 1)).toBe(2)
    expect(stepTurn(turns, offsetOf, 150, 1)).toBe(2)
    expect(stepTurn(turns, offsetOf, 150, -1)).toBe(1)
    expect(stepTurn(turns, offsetOf, 100, -1)).toBe(0)
    expect(stepTurn(turns, offsetOf, 0, -1)).toBeNull()
    expect(stepTurn(turns, offsetOf, 900, 1)).toBeNull()
  })
})

describe('compressTicks', () => {
  it('draws a tick per turn when they fit', () => {
    const turns = fixture(5, { 2: 'ask' })
    const ticks = compressTicks(turns, new Set(['user@4']), 10, 1, [1, 2])
    expect(ticks.map((t) => t.rep)).toEqual([0, 1, 2, 3, 4])
    expect(ticks.map((t) => t.state)).toEqual(['idle', 'active', 'visible', 'idle', 'idle'])
    expect(ticks[2]!.flag).toBe('ask')
    expect(ticks[4]!.bookmarked).toBe(true)
  })

  it('samples thousands of turns into the slots, keeping marks and the active turn', () => {
    const turns = fixture(5000, { 1234: 'shipped', 4000: 'ask' })
    const slots = 40
    const t = performance.now()
    const ticks = compressTicks(turns, new Set(['user@77']), slots, 2500, [2500, 2510])
    expect(performance.now() - t).toBeLessThan(50)
    expect(ticks).toHaveLength(slots)
    // Runs tile the turns exactly.
    expect(ticks[0]!.first).toBe(0)
    expect(ticks.at(-1)!.last).toBe(4999)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.first).toBe(ticks[i - 1]!.last + 1)
    expect(ticks.find((x) => x.rep === 1234)?.flag).toBe('shipped')
    expect(ticks.find((x) => x.rep === 4000)?.flag).toBe('ask')
    expect(ticks.find((x) => x.rep === 77)?.bookmarked).toBe(true)
    const active = ticks.filter((x) => x.state === 'active')
    expect(active).toHaveLength(1)
    expect(active[0]!.rep).toBe(2500)
  })

  it('is empty without turns or slots', () => {
    expect(compressTicks([], new Set(), 5, 0, [0, 0])).toEqual([])
    expect(compressTicks(fixture(3), new Set(), 0, 0, [0, 0])).toEqual([])
  })
})

describe('turnOfItem, tickAtY and marked', () => {
  const turns = fixture(5, { 3: 'ask' })
  it('names the turn a log position belongs to', () => {
    expect(turnOfItem(turns, 0)).toBe(0)
    expect(turnOfItem(turns, 1)).toBe(0)
    expect(turnOfItem(turns, 2)).toBe(1)
    expect(turnOfItem(turns, 9)).toBe(4)
    expect(turnOfItem(turns, 99)).toBe(4)
  })
  it('maps a touch height to a tick and clamps at the ends', () => {
    expect(tickAtY(0, 100, 10)).toBe(0)
    expect(tickAtY(55, 100, 10)).toBe(5)
    expect(tickAtY(-20, 100, 10)).toBe(0)
    expect(tickAtY(500, 100, 10)).toBe(9)
    expect(tickAtY(5, 100, 0)).toBe(-1)
    expect(tickAtY(5, 0, 4)).toBe(-1)
  })
  it('keeps flagged and bookmarked turns in order', () => {
    expect(marked(turns, new Set(['user@1'])).map((t) => t.key)).toEqual(['user@1', 'user@3'])
    expect(marked(turns, new Set())).toHaveLength(1)
  })
})
