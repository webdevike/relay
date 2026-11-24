import { describe, expect, it } from 'vitest'
import type { OpenAsk } from '@evaos/contract'
import type { ActivityItem } from '@evaos/chat-core/activity'
import type { Dialog, Subagent } from '@evaos/chat-core/message'
import { askDetail, stackCards, type RunCard, type StackSources } from './stack-cards'

const NOW = 10_000_000

const ask = (id: string, at: number, over: Partial<OpenAsk> = {}): OpenAsk => ({
  id,
  source: 'replies',
  label: `Label ${id}`,
  question: `Question ${id}?`,
  replies: [],
  at,
  ...over,
})
const sub = (name: string, over: Partial<Subagent> = {}): Subagent => ({
  name,
  file: `${name}.jsonl`,
  done: false,
  failed: false,
  mtimeMs: NOW,
  lastLine: `${name} is reading files`,
  tool: null,
  ...over,
})
const item = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind: 'session',
  owner: 'assistant:nova',
  title: `Title ${id}`,
  status: 'working',
  intent: `Intent ${id}`,
  startedAt: NOW - 60_000,
  updatedAt: NOW,
  open: { to: 'chat', thread: `session:${id}`, session: id },
  ...over,
})
const blocked: Dialog = {
  kind: 'ask',
  id: 'ask:b1',
  questions: [{ id: 'q', question: 'Ship it?', options: [{ label: 'Yes' }], multi: false }],
}
const src = (over: Partial<StackSources> = {}): StackSources => ({
  dialog: null,
  asks: [],
  subagents: [],
  sessionFile: '/s/chat1.jsonl',
  activity: [],
  spunOff: [],
  now: NOW,
  ...over,
})

describe('stackCards', () => {
  it('orders the blocking question first, then open asks oldest first, then running cards', () => {
    const cards = stackCards(
      src({
        dialog: blocked,
        asks: [ask('bbbbbbbb', 20), ask('aaaaaaaa', 10)],
        subagents: [sub('Scout')],
        spunOff: [item('w1')],
      }),
    )
    expect(cards.map((c) => c.id)).toEqual([
      'dialog:ask:b1',
      'ask:aaaaaaaa',
      'ask:bbbbbbbb',
      'sub:Scout',
      'run:w1',
    ])
    expect(cards[0]!.title).toBe('Ship it?')
    expect(cards[1]!.title).toBe('Label aaaaaaaa')
  })

  it('leaves out the open ask that mirrors the live dialog, and keeps it when the dialog is gone', () => {
    const mirror = ask('cccccccc', 5, { source: 'ask', askId: 'b1', sessionId: 's1' })
    const other = ask('dddddddd', 6, { source: 'ask', askId: 'zz' })
    expect(stackCards(src({ dialog: blocked, asks: [mirror, other] })).map((c) => c.id)).toEqual([
      'dialog:ask:b1',
      'ask:dddddddd',
    ])
    expect(stackCards(src({ asks: [mirror, other] })).map((c) => c.id)).toEqual([
      'ask:cccccccc',
      'ask:dddddddd',
    ])
  })

  it('a running subagent without its helper run shows its last line alone, no clock or model', () => {
    const [card] = stackCards(src({ subagents: [sub('Scout')] })) as RunCard[]
    expect(card).toMatchObject({
      title: 'Scout',
      startedAt: null,
      model: null,
      vendor: null,
      log: ['Scout is reading files'],
    })
    expect(card!.target).toMatchObject({ to: 'subagent' })
  })

  it("a subagent with its helper run takes the run's clock, model and recent work", () => {
    const helper = item('helper:/s/chat1/Scout.jsonl', {
      kind: 'helper',
      model: 'Claude Opus 5.5',
      thinking: 'high',
      log: ['one', 'two', 'three', 'four'],
    })
    const [card] = stackCards(src({ subagents: [sub('Scout')], activity: [helper] })) as RunCard[]
    expect(card).toMatchObject({
      startedAt: NOW - 60_000,
      model: 'Opus 5.5 high',
      vendor: 'anthropic',
      log: ['one', 'two', 'three', 'four'],
    })
  })

  it('an older host sends no log, vendor or thinking: the intent is the log, the model alone names it', () => {
    const [plain, named] = stackCards(
      src({ spunOff: [item('w1'), item('w2', { model: 'GPT-5.5 Codex' })] }),
    ) as RunCard[]
    expect(plain).toMatchObject({ model: null, vendor: null, log: ['Intent w1'] })
    expect(named).toMatchObject({ model: 'GPT-5.5 Codex', vendor: 'openai', log: ['Intent w2'] })
  })

  it('leaves out finished and failed subagents', () => {
    const cards = stackCards(
      src({
        subagents: [sub('Done', { done: true }), sub('Broke', { failed: true }), sub('Live')],
      }),
    )
    expect(cards.map((c) => c.id)).toEqual(['sub:Live'])
  })

  it('no question and nothing running: no cards', () => {
    expect(stackCards(src())).toEqual([])
  })
})

describe('askDetail', () => {
  it('is the question when the label does not say it, with a session default after it', () => {
    expect(askDetail(ask('a', 1))).toBe('Question a?')
    expect(askDetail(ask('a', 1, { label: 'Same?', question: 'Same?' }))).toBeNull()
    expect(
      askDetail(
        ask('a', 1, {
          source: 'session',
          label: 'Golf: tee time?',
          question: 'Book 8am or 9am?',
          replies: ['8am', '9am'],
          default: '9am',
        }),
      ),
    ).toBe('Book 8am or 9am? Going with 9am unless you say otherwise.')
  })
})
