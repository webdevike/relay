import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  quit: [] as Array<() => void>,
}))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    on: (name: string, fn: () => void) => {
      if (name === 'before-quit') ipc.quit.push(fn)
    },
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('./window', () => ({ isAppUrl: () => true }))

import { MAX_COMPOSER_DRAFTS } from '@evaos/contract'
import { createConfigStore, type ConfigStore } from './config-store'
import type { MainContext } from './context'
import { createDrafts, DRAFTS_FILE, DRAFTS_SAVE_MS, registerDraftsIpc } from './drafts-ipc'

let dir: string
let config: ConfigStore
beforeEach(() => {
  vi.useFakeTimers()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-drafts-'))
  config = createConfigStore(dir)
  ipc.handlers.clear()
  ipc.quit.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})
const onDisk = (): unknown => {
  const p = path.join(dir, DRAFTS_FILE)
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

describe('createDrafts', () => {
  it('writes within DRAFTS_SAVE_MS of the first change, batching the keystrokes after it', () => {
    let t = 1000
    const drafts = createDrafts(config, () => t++)
    drafts.save('/s/a.jsonl', 'h')
    drafts.save('/s/a.jsonl', 'hi')
    expect(onDisk()).toBeNull()
    vi.advanceTimersByTime(DRAFTS_SAVE_MS)
    expect(onDisk()).toEqual({ version: 1, drafts: { '/s/a.jsonl': { text: 'hi', at: 1001 } } })
  })

  it('flush writes a pending change at once (quit)', () => {
    const drafts = createDrafts(config)
    drafts.save('draft:3', 'unsent')
    drafts.flush()
    expect(createDrafts(config).list()).toEqual([{ key: 'draft:3', text: 'unsent' }])
  })

  it('empty text forgets the key; newest first', () => {
    let t = 0
    const drafts = createDrafts(config, () => (t += 10))
    drafts.save('/a', 'one')
    drafts.save('/b', 'two')
    drafts.save('/a', 'one more')
    expect(drafts.list().map((d) => d.key)).toEqual(['/a', '/b'])
    drafts.save('/a', '')
    drafts.flush()
    expect(createDrafts(config).list()).toEqual([{ key: '/b', text: 'two' }])
  })

  it(`keeps only the newest ${MAX_COMPOSER_DRAFTS}`, () => {
    const drafts = createDrafts(config, () => 5)
    for (let i = 0; i < MAX_COMPOSER_DRAFTS + 20; i++) drafts.save(`/s/${i}`, `text ${i}`)
    drafts.flush()
    const kept = createDrafts(config).list()
    expect(kept).toHaveLength(MAX_COMPOSER_DRAFTS)
    expect(kept[0]).toEqual({ key: `/s/${MAX_COMPOSER_DRAFTS + 19}`, text: `text 119` })
    expect(kept.some((d) => d.key === '/s/19')).toBe(false)
    expect(kept.some((d) => d.key === '/s/20')).toBe(true)
  })

  it('skips unchanged saves and bad entries in the file', () => {
    fs.writeFileSync(
      path.join(dir, DRAFTS_FILE),
      JSON.stringify({ drafts: { '/ok': { text: 'x', at: 1 }, '/bad': { text: 5 }, '': {} } }),
    )
    const drafts = createDrafts(config)
    expect(drafts.list()).toEqual([{ key: '/ok', text: 'x' }])
    drafts.save('/ok', 'x')
    drafts.save('/none', '')
    vi.advanceTimersByTime(DRAFTS_SAVE_MS)
    // Nothing changed, so nothing was written: the file still holds the entry it skipped.
    expect(onDisk()).toMatchObject({ drafts: { '/bad': { text: 5 } } })
    fs.writeFileSync(path.join(dir, DRAFTS_FILE), '{not json')
    expect(createDrafts(config).list()).toEqual([])
  })
})

describe('drafts IPC', () => {
  const ctx = (): MainContext => ({ config }) as unknown as MainContext
  const call = (channel: string, input: unknown): Promise<unknown> =>
    ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)

  it('round-trips through drafts.save and drafts.load, and survives a restart via before-quit', async () => {
    registerDraftsIpc(ctx())
    expect(await call('drafts.load', {})).toEqual({ ok: true, value: { drafts: [] } })
    expect(await call('drafts.save', { key: 'draft:2', text: 'half a thought' })).toEqual({
      ok: true,
      value: {},
    })
    expect(await call('drafts.load', {})).toEqual({
      ok: true,
      value: { drafts: [{ key: 'draft:2', text: 'half a thought' }] },
    })
    // Quit before the save timer fires: before-quit writes it.
    for (const fn of ipc.quit) fn()
    ipc.handlers.clear()
    registerDraftsIpc(ctx())
    expect(await call('drafts.load', {})).toEqual({
      ok: true,
      value: { drafts: [{ key: 'draft:2', text: 'half a thought' }] },
    })
  })

  it('a sent message (empty text) clears the saved draft', async () => {
    registerDraftsIpc(ctx())
    await call('drafts.save', { key: '/s/a.jsonl', text: 'send me' })
    await call('drafts.save', { key: '/s/a.jsonl', text: '' })
    for (const fn of ipc.quit) fn()
    expect(onDisk()).toEqual({ version: 1, drafts: {} })
  })

  it('rejects input outside the contract', async () => {
    registerDraftsIpc(ctx())
    expect(await call('drafts.save', { key: '', text: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    })
  })
})
