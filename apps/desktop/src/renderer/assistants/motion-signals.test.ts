import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import type { Assistant } from '@evaos/contract'
import { makeMessage, type ChatMessage } from '@evaos/chat-core/message'
import { dropQuietTurns } from '@evaos/chat-core/quiet'
import { Director, type MotionSignals } from '@relay/portrait-motion'
import { chatStore, type PaneState } from '../chat/chat-store'
import type { AssistantsState } from './assistants-store'
import { motionSignals, talking, turnFailed } from './motion-signals'

const FILE = '/s/nova.jsonl'

const agent = (over: Partial<Assistant> = {}): Assistant => ({
  id: 'nova',
  title: 'Nova',
  scope: '',
  avatar: { style: 'micah', seed: 'nova-17' },
  status: 'idle',
  file: FILE,
  reply: { text: 'Hi', at: 1_000 },
  ...over,
})

const state = (a: Assistant | null, over: Partial<AssistantsState> = {}): AssistantsState => ({
  data: { agents: a === null ? [] : [a], relayUp: true },
  starting: {},
  failed: {},
  ...over,
})

function pane(over: Partial<PaneState> = {}): PaneState {
  chatStore.setState({ panes: {} })
  chatStore.getState().openPane('pane-1', {
    file: FILE,
    title: 'Nova',
    messages: [],
    meta: { model: null, thinking: null, contextTokens: null },
  })
  return { ...chatStore.getState().panes['pane-1']!, ...over }
}

const user = (id: string): ChatMessage => makeMessage(id, 'user', 'hi')
const reply = (id: string, text: string, streaming = false): ChatMessage =>
  makeMessage(id, 'assistant', text, { streaming })
const tool = (id: string, status: 'running' | 'done'): ChatMessage =>
  makeMessage(id, 'tool', 'bash', {
    tool: { call: 'bash', input: 'ls', result: null, isError: false, status },
  })

const IDLE: MotionSignals = {
  running: false,
  working: false,
  talking: false,
  listening: false,
  waiting: false,
  failed: false,
  activityAt: 1_000,
}

describe('motion signals', () => {
  it('reads Relay status, Start and the reply time for any agent', () => {
    expect(motionSignals(state(agent()), 'nova', null)).toEqual(IDLE)
    expect(motionSignals(state(agent({ status: 'working' })), 'nova', null)).toMatchObject({
      running: true,
      working: false,
    })
    expect(motionSignals(state(agent({ status: 'needs-you' })), 'nova', null).waiting).toBe(true)
    // Start on its way runs before Relay lists the thread; a refused Start fails.
    const fresh = agent({ status: 'not-started', file: null, reply: null })
    expect(motionSignals(state(fresh, { starting: { nova: true } }), 'nova', null)).toMatchObject({
      running: true,
      activityAt: null,
    })
    expect(motionSignals(state(fresh, { failed: { nova: 'nope' } }), 'nova', null).failed).toBe(
      true,
    )
    // An agent the registry dropped is a quiet face.
    expect(motionSignals(state(null), 'gone', null)).toEqual({ ...IDLE, activityAt: null })
  })

  it("reads the open pane's detail only while it shows this agent's thread", () => {
    const busy = pane({
      running: true,
      dialog: { kind: 'confirm', id: 'd', title: 'Go?', message: '' },
    })
    expect(motionSignals(state(agent()), 'nova', busy)).toMatchObject({
      running: true,
      waiting: true,
    })
    const other = { ...busy, file: '/s/other.jsonl' }
    expect(motionSignals(state(agent()), 'nova', other)).toEqual(IDLE)
    // Before the thread has a file, no pane is its own.
    expect(motionSignals(state(agent({ file: null })), 'nova', busy)).toEqual(IDLE)
  })

  it('works while a tool runs in this turn, a subagent runs or a job is out', () => {
    const s = state(agent({ status: 'working' }))
    const at = (p: Partial<PaneState>) => motionSignals(s, 'nova', pane(p)).working
    expect(at({ messages: [user('u1'), tool('t1', 'running')] })).toBe(true)
    expect(at({ messages: [user('u1'), tool('t1', 'done')] })).toBe(false)
    // A tool left running in an earlier turn is not this one's.
    expect(at({ messages: [tool('t1', 'running'), user('u2')] })).toBe(false)
    const sub = { name: 'a', file: 'a.jsonl', done: false, failed: false, mtimeMs: 0, lastLine: '' }
    expect(at({ extras: { subagents: [sub], jobs: [], running: true } })).toBe(true)
    expect(at({ extras: { subagents: [{ ...sub, done: true }], jobs: [], running: true } })).toBe(
      false,
    )
    const job = { id: 'j', label: 'build', kind: 'bash', startedAt: 0 }
    expect(at({ extras: { subagents: [], jobs: [job], running: true } })).toBe(true)
  })

  it('talks exactly when ChatLog shows the reply streaming', () => {
    const chatLog = (list: ChatMessage[]): boolean => {
      const last = dropQuietTurns(list).at(-1)
      return last?.role === 'assistant' && last.streaming && last.text !== ''
    }
    const cases: ChatMessage[][] = [
      [],
      [user('u1')],
      [user('u1'), reply('a1', '', true)],
      [user('u1'), reply('a1', 'Foxes', true)],
      [user('u1'), reply('a1', 'Foxes')],
      [user('u1'), tool('t1', 'running'), reply('a1', 'Foxes', true)],
      [user('u1'), reply('a1', '(nothing to report)', true)],
      [user('u1'), reply('a0', 'Earlier'), user('u2'), reply('a1', '(nothing to report)', true)],
      [user('u1'), reply('a0', 'Reading'), reply('a1', '(nothing to report)', true)],
    ]
    for (const list of cases) expect(talking(list), JSON.stringify(list)).toBe(chatLog(list))
  })

  it("fails on the pane's error or an Error: notice in the last turn", () => {
    const s = state(agent())
    expect(motionSignals(s, 'nova', pane({ error: 'omp exited' })).failed).toBe(true)
    const failed = [user('u1'), makeMessage('n1', 'notice', 'Error: rate limited')]
    expect(turnFailed(failed)).toBe(true)
    expect(motionSignals(s, 'nova', pane({ messages: failed })).failed).toBe(true)
    // The next prompt starts over.
    expect(turnFailed([...failed, user('u2')])).toBe(false)
    expect(turnFailed([user('u1'), makeMessage('n1', 'notice', 'Stopped.')])).toBe(false)
  })

  it('drives the director through a turn: Hello, Thinking, Working, Talking, Done, Idle', () => {
    const d = new Director(0, { hello: true })
    const at = (t: number, s: Partial<MotionSignals>) => d.next({ ...IDLE, ...s }, t)
    expect(at(0, {})).toBe('hello')
    expect(at(1_000, { running: true })).toBe('thinking')
    expect(at(2_000, { running: true, working: true })).toBe('working')
    expect(at(3_000, { running: true, talking: true })).toBe('talking')
    expect(at(4_000, {})).toBe('done')
    expect(at(6_500, {})).toBe('idle')
    expect(at(7_000, { waiting: true })).toBe('confused')
    expect(at(8_000, { failed: true })).toBe('error')
  })
})
