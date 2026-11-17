import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

import type { MainContext } from '../context'
import type { RelayFeatures, RelayFrames, RelaySource } from './client'
import type { RelaySession } from './feed'
import { registerTrialsIpc } from './trials-ipc'

type Frame = Record<string, unknown>

/** Relay as the trials IPC sees it: raw frames and the host's features. */
class FakeRelay implements RelaySource, RelayFrames, RelayFeatures {
  features: string[] = ['trials']
  sent: Frame[] = []
  private changes = new Set<() => void>()
  private frames = new Set<(f: Frame) => void>()
  sessions = () => new Map<string, RelaySession>()
  onChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  onFrame(cb: (f: Frame) => void) {
    this.frames.add(cb)
    return () => this.frames.delete(cb)
  }
  sendFrame(f: Frame): boolean {
    if (this.features.length === 0) return false
    this.sent.push(f)
    return true
  }
  hostHas = (feature: string) => this.features.includes(feature)
  say(f: Frame): void {
    for (const cb of [...this.frames]) cb(f)
  }
  setFeatures(features: string[]): void {
    this.features = features
    for (const cb of this.changes) cb()
  }
}

const running = { letter: 'A', status: 'running' }
const card = {
  id: 't1',
  agent: 'diagram',
  label: 'Diagram',
  thread: 'assistant:nova',
  at: 1000,
  arms: [running, { letter: 'B', status: 'done', preview: 'B wins' }],
}
const change = {
  id: 's1',
  agent: 'diagram',
  label: 'Diagram',
  thread: 'assistant:nova',
  at: 2000,
  text: 'Diagram: switched to Sonnet 5.5',
  from: 'opus',
  to: 'sonnet',
  fromLabel: 'Opus 5.5',
  toLabel: 'Sonnet 5.5',
  kept: false,
  undone: false,
}

describe('trials IPC', () => {
  const sent: Array<[string, unknown]> = []
  const ctx = {
    shell: {
      webContents: { isDestroyed: () => false, send: (c: string, p: unknown) => sent.push([c, p]) },
    },
  } as unknown as MainContext
  const call = (channel: string, input: unknown): Promise<unknown> =>
    ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)
  beforeEach(() => {
    ipc.handlers.clear()
    sent.length = 0
  })

  it('asks on welcome, keeps the snapshot (dropping bad entries) and pushes it', async () => {
    const relay = new FakeRelay()
    const off = registerTrialsIpc(ctx, relay)
    // Already connected when registered: it asks at once.
    expect(relay.sent).toEqual([{ t: 'trials.get' }])
    relay.say({ t: 'welcome' })
    expect(relay.sent).toEqual([{ t: 'trials.get' }, { t: 'trials.get' }])
    relay.say({
      t: 'trials.snapshot',
      trials: [card, { id: 'bad', arms: [] }],
      switches: [change, 7],
    })
    const view = { up: true, trials: [card], switches: [change] }
    expect(sent.at(-1)).toEqual(['trials.changed', view])
    expect(await call('trials.get', {})).toEqual({ ok: true, value: view })
    // The host going away keeps the cards; one without the feature has none.
    relay.setFeatures([])
    expect(sent.at(-1)).toEqual(['trials.changed', { ...view, up: false }])
    relay.say({ t: 'welcome' })
    expect(sent.at(-1)).toEqual(['trials.changed', { up: false, trials: [], switches: [] }])
    off()
    relay.say({ t: 'trials.snapshot', trials: [card], switches: [] })
    expect(sent.at(-1)).toEqual(['trials.changed', { up: false, trials: [], switches: [] }])
  })

  it("sends a pick and an undo and resolves with the host's answers", async () => {
    const relay = new FakeRelay()
    registerTrialsIpc(ctx, relay)
    const picked = call('trials.pick', { trial: 't1', pick: 'B' })
    await vi.waitFor(() =>
      expect(relay.sent.at(-1)).toEqual({
        t: 'trial.pick',
        trial: 't1',
        pick: 'B',
        surface: 'desktop',
      }),
    )
    // Another card's answer is not this one's.
    relay.say({ t: 'trial.picked', trial: 't2', ok: true })
    relay.say({ t: 'trial.picked', trial: 't1', ok: true })
    expect(await picked).toEqual({ ok: true, value: { ok: true } })

    const undone = call('trials.undo', { switch: 's1' })
    await vi.waitFor(() => expect(relay.sent.at(-1)).toEqual({ t: 'trial.undo', switch: 's1' }))
    relay.say({ t: 'trial.undone', switch: 's1', ok: false, error: 'Already undone' })
    expect(await undone).toEqual({ ok: true, value: { ok: false, error: 'Already undone' } })

    expect(await call('trials.pick', { trial: 't1', pick: 'D' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    })
    relay.setFeatures([])
    expect(await call('trials.pick', { trial: 't1', pick: 'unsure' })).toEqual({
      ok: true,
      value: { ok: false, error: "Relay isn't connected." },
    })
  })
})
