import { describe, expect, it } from 'vitest'
import { firstSentence, parseBackground } from './background'

describe('parseBackground', () => {
  it('reads a heartbeat into per-source counts and items', () => {
    const text = [
      "[From Nova's background jobs] Heartbeat: 3 new.",
      '[gmail] Anthropic: Your receipt #2773 (2026-10-21T20:44:34Z)',
      '[gmail] Anthropic: Your Max subscription is confirmed (2026-10-21T20:44:29Z)',
      '[work] Personal and work omp profiles (https://linear.app/eva/issue/ENG-1)',
    ].join('\n')
    expect(parseBackground(text)).toEqual({
      kind: 'heartbeat',
      from: 'Nova',
      count: 3,
      sources: [
        { source: 'gmail', count: 2 },
        { source: 'work', count: 1 },
      ],
      items: [
        {
          source: 'gmail',
          title: 'Anthropic: Your receipt #2773',
          meta: '2026-10-21T20:44:34Z',
          link: null,
        },
        {
          source: 'gmail',
          title: 'Anthropic: Your Max subscription is confirmed',
          meta: '2026-10-21T20:44:29Z',
          link: null,
        },
        {
          source: 'work',
          title: 'Personal and work omp profiles',
          meta: 'https://linear.app/eva/issue/ENG-1',
          link: 'https://linear.app/eva/issue/ENG-1',
        },
      ],
      text,
    })
  })

  it('reads a job line as a one-line event led by its source', () => {
    const text =
      "[From Astra's background jobs] auto-work ENG-6648 replied to a coworker. Reply: Thanks Dana."
    expect(parseBackground(text)).toEqual({
      kind: 'event',
      icon: 'robot',
      summary: 'Astra · auto-work ENG-6648 replied to a coworker',
      text,
    })
  })

  it('names Relay Assist handoffs, canvas notices and tapbacks', () => {
    expect(
      parseBackground(
        "[From Nova's background jobs] [Relay Assist handoff] Isaac said hi while looking at Linear.\nTicket: ENG-1",
      ),
    ).toMatchObject({
      kind: 'event',
      icon: 'hand',
      summary: 'Relay Assist · Isaac said hi while looking at Linear',
    })
    expect(
      parseBackground('Live canvas started on "Live UI demo" (board live-ui-demo, new).'),
    ).toMatchObject({ kind: 'event', icon: 'board', summary: 'Canvas · started "Live UI demo"' })
    expect(parseBackground('Canvas "Demo" · Isaac: move the chart left')).toMatchObject({
      kind: 'event',
      icon: 'chat',
      summary: 'Canvas "Demo" · Isaac · move the chart left',
    })
    expect(parseBackground('[Isaac reacted 👍 to your message: "Done."]')).toMatchObject({
      kind: 'event',
      icon: 'reaction',
      summary: 'Isaac reacted 👍 to "Done"',
    })
  })

  it("shows another assistant's question as a quiet row in the asked assistant's thread", () => {
    expect(
      parseBackground("[Asked by Nova in Isaac's chat] Find a 2TB USB4 SSD under $200. Isaac wants it by Friday."),
    ).toMatchObject({ kind: 'event', icon: 'chat', summary: 'Nova asked · Find a 2TB USB4 SSD under $200' })
  })

  it('leaves what Isaac typed alone', () => {
    expect(parseBackground('hello Nova')).toBeNull()
    expect(parseBackground('   ')).toBeNull()
    expect(parseBackground('Heartbeat: 3 new.')).toBeNull()
  })
})

describe('firstSentence', () => {
  it('keeps one bounded line', () => {
    expect(firstSentence('First. Second.')).toBe('First')
    expect(firstSentence('one\ntwo')).toBe('one')
    expect(firstSentence('x'.repeat(400)).length).toBe(160)
  })
})
