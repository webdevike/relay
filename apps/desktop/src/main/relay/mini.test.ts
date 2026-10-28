import { describe, expect, it } from 'vitest'
import type { RelayFrames } from './client'
import type { RelaySession } from './feed'
import { createMini, NO_MINI_CHAT } from './mini'

type Frame = Record<string, unknown>

/** The Mini's Relay Host: answers each frame sent with whatever `answer` returns. */
function host(answer: (f: Frame) => Frame[]): RelayFrames & { sent: Frame[] } {
  const listeners = new Set<(f: Frame) => void>()
  const sent: Frame[] = []
  return {
    sent,
    onFrame: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    sendFrame: (f) => {
      sent.push(f)
      queueMicrotask(() => {
        for (const reply of answer(f)) for (const cb of [...listeners]) cb(reply)
      })
      return true
    },
  }
}

const live = new Map<string, RelaySession>([
  [
    'out',
    {
      id: 'out',
      status: 'idle',
      detail: null,
      canRespond: true,
      kind: 'manual',
      title: '',
      assistant: null,
    },
  ],
])

describe('createMini', () => {
  it('starts or resumes omp on the Mini and resolves agent.started.sessionId', async () => {
    const h = host((f) => [
      { t: 'ack', id: f.id },
      { t: 'agent.started', id: 'other', sessionId: 'wrong' },
      { t: 'agent.started', id: f.id, sessionId: 'abc' },
    ])
    const mini = createMini(h, () => live, () => 7)
    await expect(mini.start({ resume: 'abc', profile: 'work', thinking: 'high' })).resolves.toBe(
      'abc',
    )
    expect(h.sent).toEqual([
      {
        t: 'cmd',
        id: 'relay-desktop-start-7-1',
        cmd: { kind: 'agent.start', resume: 'abc', profile: 'work', thinkingLevel: 'high' },
      },
    ])
  })
  it('fails a start the host refuses', async () => {
    const h = host((f) => [
      { t: 'nack', id: f.id, error: { code: 'agent_not_found', message: 'No such chat.' } },
    ])
    await expect(createMini(h, () => live).start({ profile: null })).rejects.toThrow(
      'No such chat.',
    )
  })
  it("lists a running chat's models and commands, and plan usage", async () => {
    const usage = { accounts: [], updatedAt: 5, refreshing: false }
    const h = host((f) =>
      f.t === 'usage.get'
        ? [{ t: 'usage.snapshot', usage }]
        : [
            {
              t: 'agent.options',
              sessionId: 'out',
              models: [
                { provider: 'anthropic', id: 'fable', name: 'Fable', vendor: 'anthropic', thinkingLevels: ['high'] },
              ],
              skills: [
                { name: 'Goal', description: '', command: '/goal', takesText: true },
                {
                  name: 'Security',
                  description: 'Scan',
                  command: '/security',
                  takesText: true,
                  hint: '[path]',
                  choices: [{ name: 'Scan', description: 'Run', command: '/security scan', takesText: false }],
                },
              ],
            },
          ],
    )
    const mini = createMini(h, () => live)
    expect(mini.peekModels()).toBeNull()
    const options = await mini.options()
    expect(h.sent[0]).toEqual({ t: 'agent.options', sessionId: 'out' })
    expect(options.models).toEqual([
      { provider: 'anthropic', id: 'fable', name: 'Fable', contextWindow: null, images: true, levels: ['high'] },
    ])
    expect(options.commands).toEqual([
      {
        name: 'security',
        description: 'Scan',
        hint: '[path]',
        subcommands: [{ name: 'scan', description: 'Run', hint: null, subcommands: [] }],
      },
    ])
    expect(mini.peekModels()).toBe(options.models)
    await expect(mini.usage()).resolves.toEqual(usage)
    await expect(createMini(h, () => null).options()).rejects.toThrow(NO_MINI_CHAT)
  })
})
