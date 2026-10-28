import { describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => {} }))

import type { Assistant } from '@evaos/contract'
import { makeMessage, type ChatMessage, type Subagent } from '@evaos/chat-core/message'
import { Director, statusDot, type MotionSignals } from '@relay/portrait-motion'
import { chatStore, type PaneState } from '../chat/chat-store'
import type { AssistantsState } from './assistants-store'
import { motionSignals, toolOf, turnFailed } from './motion-signals'

const FILE = '/s/nova.jsonl'

const agent = (over: Partial<Assistant> = {}): Assistant => ({
  id: 'nova',
  title: 'Nova',
  scope: '',
  avatar: { style: 'micah', seed: 'nova-17' },
  status: 'idle',
  tool: null,
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
const tool = (id: string, name: string, status: 'running' | 'done'): ChatMessage =>
  makeMessage(id, 'tool', name, {
    tool: { call: id, input: '', result: null, isError: false, status },
  })
const sub = (name: string, tool: string | null, done = false): Subagent => ({
  name,
  file: `${name}.jsonl`,
  done,
  failed: false,
  mtimeMs: 0,
  lastLine: '',
  tool,
})
const extras = (subagents: Subagent[], jobs = 0): PaneState['extras'] => ({
  subagents,
  jobs: Array.from({ length: jobs }, (_, i) => ({
    id: `j${i}`,
    label: 'build',
    kind: 'bash',
    startedAt: 0,
  })),
  running: true,
})

const IDLE: MotionSignals = {
  running: false,
  tool: null,
  waiting: false,
  failed: false,
  activityAt: 1_000,
}

describe('motion signals', () => {
  it("reads Relay's status and running tool, Start and the reply time for any agent", () => {
    expect(motionSignals(state(agent()), 'nova', null)).toEqual(IDLE)
    expect(motionSignals(state(agent({ status: 'working' })), 'nova', null)).toMatchObject({
      running: true,
      tool: null,
    })
    const searching = agent({ status: 'working', tool: 'web_search' })
    expect(motionSignals(state(searching), 'nova', null).tool).toBe('research')
    expect(
      motionSignals(state(agent({ status: 'working', tool: 'bash' })), 'nova', null).tool,
    ).toBe('work')
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
      messages: [user('u1'), tool('t1', 'grep', 'running')],
    })
    expect(motionSignals(state(agent()), 'nova', busy)).toMatchObject({
      running: true,
      tool: 'research',
      waiting: true,
    })
    const other = { ...busy, file: '/s/other.jsonl' }
    expect(motionSignals(state(agent()), 'nova', other)).toEqual(IDLE)
    // Before the thread has a file, no pane is its own.
    expect(motionSignals(state(agent({ file: null })), 'nova', busy)).toEqual(IDLE)
  })

  it('a streaming reply is just the turn running', () => {
    const p = pane({ running: true, messages: [user('u1'), reply('a1', 'Foxes', true)] })
    expect(motionSignals(state(agent()), 'nova', p)).toMatchObject({ running: true, tool: null })
  })

  it("names what the turn's tools do: subagents first, then Relay's tool, the pane's rows, jobs", () => {
    const at = (relay: string | null, p: Partial<PaneState>) => toolOf(relay, pane(p))
    // Running subagents stand in for the task tool that spawned them.
    expect(at('task', { extras: extras([sub('a', 'web_search'), sub('b', 'read')]) })).toBe(
      'research',
    )
    expect(at('task', { extras: extras([sub('a', 'web_search'), sub('b', 'edit')]) })).toBe('work')
    // A finished subagent, or one between tools, says nothing.
    expect(at('bash', { extras: extras([sub('a', 'read', true), sub('b', null)]) })).toBe('work')
    expect(at('fetch', {})).toBe('research')
    // Without Relay's word, the newest running tool row of this turn.
    expect(
      at(null, {
        messages: [user('u1'), tool('t1', 'bash', 'done'), tool('t2', 'read', 'running')],
      }),
    ).toBe('research')
    expect(at(null, { messages: [user('u1'), tool('t1', 'edit', 'running')] })).toBe('work')
    expect(at(null, { messages: [tool('t1', 'edit', 'running'), user('u2')] })).toBeNull()
    expect(at(null, { extras: extras([], 1) })).toBe('work')
    expect(toolOf(null, null)).toBeNull()
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

  it('drives the director calmly: Idle, Thinking, Researching, Working, Thinking, Idle', () => {
    const d = new Director()
    const at = (t: number, s: Partial<MotionSignals>) => d.next({ ...IDLE, ...s }, t)
    expect(at(0, {})).toBe('idle')
    expect(at(1_000, { running: true })).toBe('thinking')
    expect(at(2_000, { running: true, tool: 'research' })).toBe('researching')
    expect(at(3_000, { running: true, tool: 'work' })).toBe('working')
    expect(at(4_000, { running: true })).toBe('thinking')
    expect(at(5_000, {})).toBe('idle')
    // Needing Isaac and failing are the dot alone.
    expect(at(6_000, { running: true, waiting: true })).toBe('idle')
    expect(statusDot({ ...IDLE, running: true, waiting: true })).toBe('orange')
    expect(at(7_000, { failed: true })).toBe('idle')
    expect(statusDot({ ...IDLE, failed: true })).toBe('red')
  })
})
