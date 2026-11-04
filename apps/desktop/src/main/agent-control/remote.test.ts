import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentResult } from '@evaos/contract'
import type { RelayFrames } from '../relay/client'
import { startRemoteControl, type PresenceState } from './remote'
import { runAgentRequest } from './run'
import type { RunBody } from './server'

class FakeHost implements RelayFrames {
  readonly sent: Record<string, unknown>[] = []
  private readonly cbs = new Set<(f: Record<string, unknown>) => void>()
  onFrame(cb: (f: Record<string, unknown>) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  sendFrame(frame: Record<string, unknown>): boolean {
    this.sent.push(frame)
    return true
  }
  push(frame: Record<string, unknown>): void {
    for (const cb of [...this.cbs]) cb(frame)
  }
  /** Resolves once the app answered `rid`. */
  async answer(rid: string): Promise<Record<string, unknown>> {
    await vi.waitFor(() => {
      if (!this.sent.some((f) => f.t === 'control.res' && f.rid === rid))
        throw new Error('no answer')
    })
    return this.sent.find((f) => f.t === 'control.res' && f.rid === rid) as Record<string, unknown>
  }
}

const STATE: PresenceState = {
  name: 'Isaacs-MacBook-Pro',
  instance: 'stable',
  idleMs: 1200,
  page: 'settings',
  focused: true,
  remote: true,
}

function setup(run: (id: string, body: RunBody) => Promise<AgentResult>) {
  const host = new FakeHost()
  let clock = 10_000
  const remote = startRemoteControl({
    frames: host,
    run,
    catalog: () => [{ id: 'describe' }],
    presence: () => STATE,
    now: () => clock,
  })
  return { host, remote, tick: (ms: number) => (clock += ms) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('remote control (desktop side)', () => {
  it('says it can be driven only to a host that lists "control", on every welcome', () => {
    const { host } = setup(() => Promise.resolve({ ok: true, value: null }))
    host.push({ t: 'welcome', features: ['query'] })
    expect(host.sent).toEqual([])
    host.push({ t: 'welcome', features: ['query', 'control'] })
    expect(host.sent).toEqual([{ t: 'control.presence', ...STATE }])
  })

  it('tells the host about input at most once a second, the last change included', () => {
    vi.useFakeTimers()
    const { host, remote, tick } = setup(() => Promise.resolve({ ok: true, value: null }))
    remote.changed()
    expect(host.sent).toEqual([])
    host.push({ t: 'welcome', features: ['control'] })
    remote.changed()
    remote.changed()
    expect(host.sent).toHaveLength(1)
    tick(1000)
    vi.advanceTimersByTime(1000)
    expect(host.sent).toHaveLength(2)
    tick(5000)
    remote.changed()
    expect(host.sent).toHaveLength(3)
  })

  it('runs control.req through the control runner and answers with the same rid', async () => {
    const calls: Array<[string, RunBody]> = []
    const { host } = setup((id, body) => {
      calls.push([id, body])
      return Promise.resolve({ ok: true, value: { text: 'Settings > Theme' } })
    })
    host.push({ t: 'welcome', features: ['control'] })
    host.push({ t: 'control.req', rid: 'r1', action: 'describe', scope: 'agent:nova' })
    expect(await host.answer('r1')).toEqual({
      t: 'control.res',
      rid: 'r1',
      result: { ok: true, value: { text: 'Settings > Theme' } },
    })
    host.push({
      t: 'control.req',
      rid: 'r2',
      action: 'settings.set',
      params: { key: 'theme.mode', value: 'light' },
    })
    await host.answer('r2')
    expect(calls).toEqual([
      ['describe', { scope: 'agent:nova' }],
      ['settings.set', { params: { key: 'theme.mode', value: 'light' } }],
    ])
    host.push({ t: 'control.req', rid: 'r3', action: '@actions' })
    expect(await host.answer('r3')).toMatchObject({
      result: { ok: true, value: [{ id: 'describe' }] },
    })
  })

  it("keeps the local API's rules: a destructive action needs confirm and Isaac's yes", async () => {
    const asked: string[] = []
    let approve = false
    const { host } = setup((id, body) =>
      runAgentRequest(id, body, {
        run: () => Promise.resolve({ ok: true, value: { quitting: true } }),
        ask: (aid) => {
          asked.push(aid)
          return Promise.resolve(approve)
        },
      }),
    )
    host.push({ t: 'control.req', rid: 'q1', action: 'app.quit' })
    expect(await host.answer('q1')).toMatchObject({
      result: { ok: false, code: 'confirm-required' },
    })
    host.push({ t: 'control.req', rid: 'q2', action: 'app.quit', confirm: true })
    expect(await host.answer('q2')).toMatchObject({ result: { ok: false, code: 'denied' } })
    approve = true
    host.push({ t: 'control.req', rid: 'q3', action: 'app.quit', confirm: true })
    expect(await host.answer('q3')).toMatchObject({ result: { ok: true } })
    expect(asked).toEqual(['app.quit', 'app.quit'])
    host.push({ t: 'control.req', rid: 'q4', action: 'nope.nope' })
    expect(await host.answer('q4')).toMatchObject({ result: { ok: false, code: 'unknown-action' } })
  })

  it('keeps a failure inside what the host accepts and ignores malformed requests', async () => {
    const { host } = setup(() =>
      Promise.resolve({ ok: false, code: '', message: 'x'.repeat(5000) }),
    )
    host.push({ t: 'control.req', rid: '', action: 'describe' })
    host.push({ t: 'control.req', rid: 'big', action: 'describe' })
    const res = (await host.answer('big')) as { result: { code: string; message: string } }
    expect(res.result.code).toBe('internal')
    expect(res.result.message).toHaveLength(4000)
    expect(host.sent.filter((f) => f.t === 'control.res')).toHaveLength(1)
  })
})
