import { describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('electron', () => ({ nativeImage: {}, WebContentsView: class {} }))

import { runAgentRequest, type RunDeps } from './run'
import { blit } from './screenshot'

interface MockDeps extends RunDeps {
  run: Mock<RunDeps['run']>
  ask: Mock<RunDeps['ask']>
}

function deps(approve: boolean): MockDeps {
  return {
    run: vi.fn<RunDeps['run']>(async () => ({ ok: true, value: 'done' })),
    ask: vi.fn<RunDeps['ask']>(async () => approve),
  }
}

describe('runAgentRequest', () => {
  it('runs a safe action without asking', async () => {
    const d = deps(false)
    const r = await runAgentRequest('tab.open', { params: { kind: 'files' } }, d)
    expect(r).toEqual({ ok: true, value: 'done' })
    expect(d.ask).not.toHaveBeenCalled()
    expect(d.run).toHaveBeenCalledWith('tab.open', expect.anything(), { kind: 'files' })
  })

  it('needs confirm: true for a destructive action and never shows the toast without it', async () => {
    const d = deps(true)
    for (const confirm of [undefined, false]) {
      const r = await runAgentRequest('app.quit', { confirm }, d)
      expect(r).toMatchObject({ ok: false, code: 'confirm-required' })
    }
    expect(d.ask).not.toHaveBeenCalled()
    expect(d.run).not.toHaveBeenCalled()
  })

  it('denies a destructive action unless Isaac approves (a timeout counts as no)', async () => {
    const denied = deps(false)
    const r = await runAgentRequest(
      'chat.start',
      { confirm: true, params: { prompt: 'hi' } },
      denied,
    )
    expect(r).toMatchObject({ ok: false, code: 'denied' })
    expect(denied.ask).toHaveBeenCalledOnce()
    expect(denied.run).not.toHaveBeenCalled()

    const approved = deps(true)
    const ok = await runAgentRequest('app.quit', { confirm: true }, approved)
    expect(ok).toEqual({ ok: true, value: 'done' })
    expect(approved.run).toHaveBeenCalledOnce()
  })

  it('validates params before asking', async () => {
    const d = deps(true)
    const r = await runAgentRequest('chat.start', { confirm: true, params: { prompt: '' } }, d)
    expect(r).toMatchObject({ ok: false, code: 'invalid-params' })
    expect(d.ask).not.toHaveBeenCalled()
  })

  it('rejects unknown ids, including prototype keys', async () => {
    for (const id of ['nope', 'constructor', '__proto__']) {
      expect(await runAgentRequest(id, {}, deps(true))).toMatchObject({ code: 'unknown-action' })
    }
  })

  it('turns a coded throw into its code', async () => {
    const d = deps(true)
    d.run.mockRejectedValueOnce(Object.assign(new Error('outside'), { code: 'outside-eva' }))
    expect(await runAgentRequest('files.open', { params: { path: '/x' } }, d)).toEqual({
      ok: false,
      code: 'outside-eva',
      message: 'outside',
    })
  })

  it("gives panel actions the caller's scope unless their params name one", async () => {
    const d = deps(true)
    await runAgentRequest('browser.open', { params: { url: 'x.test' }, scope: 'agent:nova' }, d)
    expect(d.run).toHaveBeenLastCalledWith('browser.open', expect.anything(), {
      url: 'x.test',
      scope: 'agent:nova',
    })
    await runAgentRequest(
      'tab.open',
      { params: { kind: 'files', scope: 'test-bench' }, scope: 'agent:nova' },
      d,
    )
    expect(d.run).toHaveBeenLastCalledWith('tab.open', expect.anything(), {
      kind: 'files',
      scope: 'test-bench',
    })
    // Pane layout acts on the whole window: the caller's scope stays out.
    await runAgentRequest('pane.close', { params: { pane: 'p2' }, scope: 'agent:nova' }, d)
    expect(d.run).toHaveBeenLastCalledWith('pane.close', expect.anything(), { pane: 'p2' })
    // Page changes and the rest go where they always went.
    await runAgentRequest('page.open', { params: { page: 'jobs' }, scope: 'agent:nova' }, d)
    expect(d.run).toHaveBeenLastCalledWith('page.open', expect.anything(), { page: 'jobs' })
    await runAgentRequest(
      'testbench.open',
      { params: { experiment: 'e1' }, scope: 'agent:nova' },
      d,
    )
    expect(d.run).toHaveBeenLastCalledWith('testbench.open', expect.anything(), {
      experiment: 'e1',
    })
    // Artifacts actions act on the caller's own thread.
    await runAgentRequest('artifacts.list', { params: {}, scope: 'agent:nova' }, d)
    expect(d.run).toHaveBeenLastCalledWith('artifacts.list', expect.anything(), {
      scope: 'agent:nova',
    })
  })
})

describe('blit', () => {
  it('copies a view into the window bitmap at its offset, clipped at the edges', () => {
    const dst = Buffer.alloc(4 * 4 * 4)
    const src = Buffer.alloc(2 * 2 * 4, 0xff)
    blit(dst, 4, 4, src, 2, 2, 3, 3)
    const px = (x: number, y: number) => dst[(y * 4 + x) * 4]
    expect(px(3, 3)).toBe(0xff)
    expect(px(2, 3)).toBe(0)
    expect(px(3, 2)).toBe(0)
    blit(dst, 4, 4, src, 2, 2, 0, 0)
    expect(px(0, 0)).toBe(0xff)
    expect(px(1, 1)).toBe(0xff)
    expect(px(2, 2)).toBe(0)
  })
})
