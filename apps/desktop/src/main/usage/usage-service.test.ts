import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { UsageSnapshot } from '@evaos/contract'
import type { CaptureResult } from '../eva/spawn'
import { createUsageService, USAGE_FOCUS_MIN_MS } from './usage-service'

const FIXTURES = path.resolve(__dirname, '../../../../../fixtures')
const PROFILES = path.join(FIXTURES, 'omp-profiles')
const ok = (profile: string): CaptureResult => ({
  code: 0,
  stdout: fs.readFileSync(path.join(FIXTURES, 'fake-omp/usage', `${profile}.json`), 'utf8'),
  stderr: '',
  timedOut: false,
})

function setup(run: (profile: string) => Promise<CaptureResult>) {
  let t = 1_000_000
  const emitted: UsageSnapshot[] = []
  const calls: string[] = []
  const service = createUsageService({
    profilesDir: PROFILES,
    run: (p, timeoutMs) => {
      calls.push(`${p}:${timeoutMs}`)
      return run(p)
    },
    emit: (s) => emitted.push(s),
    now: () => t,
  })
  return { service, emitted, calls, advance: (ms: number) => (t += ms) }
}

describe('usage service', () => {
  it('fetches every profile in parallel with the timeout, provider-major', async () => {
    const { service, emitted, calls } = setup(async (p) => ok(p))
    const done = await service.refresh()
    expect(calls.sort()).toEqual(['personal:20000', 'work:20000'])
    expect(done.accounts.map((a) => a.key)).toEqual([
      'personal:anthropic',
      'work:anthropic',
      'personal:openai-codex',
      'work:openai-codex',
    ])
    expect(done.updatedAt).toBe(1_000_000)
    expect(done.refreshing).toBe(false)
    expect(emitted.map((s) => s.refreshing)).toEqual([true, false])
    expect(service.get()).toEqual(done)
  })

  it('joins a refresh already running', async () => {
    const { service, calls } = setup(async (p) => ok(p))
    const a = service.refresh()
    const b = service.refresh()
    expect(b).toBe(a)
    await a
    expect(calls).toHaveLength(2)
  })

  it('keeps last good data stale for the profile that fails, fresh for the other', async () => {
    let failWork = false
    const { service } = setup(async (p) =>
      p === 'work' && failWork
        ? { code: 1, stdout: '', stderr: 'network down\n', timedOut: false }
        : ok(p),
    )
    await service.refresh()
    failWork = true
    const s = await service.refresh()
    const byKey = Object.fromEntries(s.accounts.map((a) => [a.key, a]))
    expect(byKey['work:anthropic']).toMatchObject({ stale: true, error: 'network down' })
    expect(byKey['work:anthropic']!.windows).toHaveLength(3)
    expect(byKey['personal:anthropic']).toMatchObject({ stale: false, error: null })
  })

  it('reports unreadable output and a rejected run without numbers', async () => {
    const { service } = setup(async (p) => {
      if (p === 'work') throw new Error('spawn ENOENT')
      return { code: 0, stdout: 'garbage', stderr: '', timedOut: false }
    })
    const s = await service.refresh()
    const byKey = Object.fromEntries(s.accounts.map((a) => [a.key, a]))
    expect(byKey['personal:anthropic']).toMatchObject({
      windows: [],
      error: 'omp usage printed output Relay could not read',
    })
    expect(byKey['work:openai-codex']).toMatchObject({ windows: [], error: 'spawn ENOENT' })
  })

  it('refreshes on focus only when the last refresh is over a minute old', async () => {
    const run = vi.fn(async (p: string) => ok(p))
    const { service, advance } = setup(run)
    service.refreshIfOld()
    await service.refresh()
    expect(run).toHaveBeenCalledTimes(2)
    advance(USAGE_FOCUS_MIN_MS)
    service.refreshIfOld()
    expect(run).toHaveBeenCalledTimes(2)
    advance(1)
    service.refreshIfOld()
    await service.refresh()
    expect(run).toHaveBeenCalledTimes(4)
  })
})
