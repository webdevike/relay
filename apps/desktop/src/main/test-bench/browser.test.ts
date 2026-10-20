import { describe, expect, it } from 'vitest'
import { BENCH_LIMITS } from '@evaos/contract'
import { FIXTURES } from './fixtures'

// Execute these cases in Electron main mode during integrated proof, not Node's Electron stub.
describe.skipIf(!process.versions.electron)('real disposable fixture browser', () => {
  it('measures actual labels, clipping, keyboard and save/reload with real PNGs', async () => {
    const { app, webContents } = await import('electron')
    const { collectBrowser } = await import('./browser')
    await app.whenReady()
    const initial = webContents.getAllWebContents().length
    for (const fixture of FIXTURES) {
      const result = await collectBrowser(fixture, BENCH_LIMITS, new AbortController().signal)
      expect(result.before.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(result.after.length).toBeGreaterThan(1000)
      if (fixture.withheld) expect(result.observations[fixture.action]).toBeNull()
      else if (fixture.action === 'label')
        expect(result.observations.label!.associated).toBe(fixture.associated)
      else if (fixture.action === 'clipping')
        expect(result.observations.clipping!.clipped).toBe(fixture.width < 240)
      else if (fixture.action === 'keyboard')
        expect(result.observations.keyboard!.sequence).toEqual(
          fixture.reachable ? ['field', 'save'] : ['save', 'body'],
        )
      else
        expect(result.observations.persistence!.afterReload).toBe(
          fixture.durable ? fixture.entered : fixture.initial,
        )
      expect(webContents.getAllWebContents()).toHaveLength(initial)
    }
  }, 120_000)
  it('closes owned contents on abort and capture timeout', async () => {
    const { app, webContents } = await import('electron')
    const { collectBrowser } = await import('./browser')
    await app.whenReady()
    const initial = webContents.getAllWebContents().length
    const controller = new AbortController()
    const pending = collectBrowser(FIXTURES[0]!, BENCH_LIMITS, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await expect(
      collectBrowser(FIXTURES[0]!, { ...BENCH_LIMITS, captureMs: 1 }, new AbortController().signal),
    ).rejects.toThrow()
    expect(webContents.getAllWebContents()).toHaveLength(initial)
  })
})
