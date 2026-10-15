import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  ipcMain: {},
  BaseWindow: class {},
  WebContentsView: class {},
}))

import { createConfigStore, type ConfigStore } from './config-store'
import { loadLayout, saveLayout } from './layout-ipc'
import { loadAppearance, readLastBackground, saveAppearance, saveLastBackground } from './theme-ipc'
import { loadSettings, saveSettings } from './settings-ipc'
import { createWriteQueue } from './write-queue'

let dir: string
let config: ConfigStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-cfg-'))
  config = createConfigStore(dir)
})
const read = (n: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))

describe('layout', () => {
  it('defaults when missing, reset when malformed, clamps', () => {
    expect(loadLayout(config)).toEqual({
      sidebarWidth: 272,
      panelWidth: 420,
      tabs: null,
      reset: false,
    })
    fs.writeFileSync(path.join(dir, 'layout.json'), '{not json')
    expect(loadLayout(config)).toMatchObject({ sidebarWidth: 272, panelWidth: 420, reset: true })
    fs.writeFileSync(path.join(dir, 'layout.json'), '{"sidebar_width": 9999}')
    expect(loadLayout(config).sidebarWidth).toBe(420)
  })
  it('merge-writes, keeping unknown keys, through the queue in order', async () => {
    fs.writeFileSync(path.join(dir, 'layout.json'), '{"zoom": 2}')
    const q = createWriteQueue()
    const tabs = { active: 0, list: [] }
    await Promise.all([
      q.enqueue(() => saveLayout(config, { sidebarWidth: 300.4, tabs })),
      q.enqueue(() => saveLayout(config, { panelWidth: 500 })),
    ])
    expect(read('layout.json')).toMatchObject({
      sidebar_width: 300,
      panel_width: 500,
      zoom: 2,
      tabs,
    })
  })
  it('queue survives a rejected task', async () => {
    const q = createWriteQueue()
    await expect(q.enqueue(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(q.enqueue(() => 5)).resolves.toBe(5)
  })
})

describe('theme', () => {
  it('keeps other keys and falls back to system', () => {
    fs.writeFileSync(
      path.join(dir, 'theme.json'),
      '{"base":"X","app":{"appearance":"dark","lastBackground":"#111111"}}',
    )
    saveAppearance(config, 'light')
    expect(read('theme.json')).toEqual({
      base: 'X',
      app: { appearance: 'light', lastBackground: '#111111' },
    })
    fs.writeFileSync(path.join(dir, 'theme.json'), '{"app":{"appearance":"neon"}}')
    expect(loadAppearance(config)).toBe('system')
  })
  it('persists the last background', () => {
    expect(readLastBackground(config)).toBe('#181817')
    saveLastBackground(config, '#222222')
    expect(readLastBackground(config)).toBe('#222222')
  })
})

describe('settings', () => {
  it('defaults follow Rust: thinking off, tools on, harness omp', () => {
    expect(loadSettings(config)).toEqual({ show_thinking: false, show_tools: true, harness: 'omp' })
  })
  it('chat.json wins, settings.json fills missing keys', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), '{"show_thinking":true,"chat_categories":["X"]}')
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"show_tools":false,"show_thinking":false}')
    expect(loadSettings(config)).toEqual({ show_thinking: true, show_tools: false, harness: 'omp' })
  })
  it('save writes chat.json, keeps unknown keys, never touches settings.json', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), '{"chat_categories":["X"],"zoom":2}')
    const legacy = '{"show_tools":false}'
    fs.writeFileSync(path.join(dir, 'settings.json'), legacy)
    expect(saveSettings(config, { harness: 'claude' })).toEqual({
      show_thinking: false,
      show_tools: false,
      harness: 'claude',
    })
    expect(read('chat.json')).toEqual({ chat_categories: ['X'], zoom: 2, harness: 'claude' })
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe(legacy)
  })
  it('partial saves survive reload', () => {
    saveSettings(config, { show_thinking: true })
    saveSettings(config, { show_tools: false })
    expect(loadSettings(createConfigStore(dir))).toEqual({
      show_thinking: true,
      show_tools: false,
      harness: 'omp',
    })
  })
  it('a corrupt chat.json is backed up and the save still succeeds', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), '{broken')
    expect(saveSettings(config, { harness: 'claude' }).harness).toBe('claude')
    expect(fs.readFileSync(path.join(dir, 'chat.json.bad'), 'utf8')).toBe('{broken')
  })
  it('chat.harnessStatus reflects whether the claude files exist', async () => {
    const handlers = new Map<string, () => unknown>()
    vi.doMock('./ipc/handle', () => ({
      handle: (_c: unknown, name: string, fn: () => unknown) => handlers.set(name, fn),
    }))
    vi.resetModules()
    const { registerSettingsIpc } = await import('./settings-ipc')
    const bin = path.join(dir, 'claude')
    const bridge = path.join(dir, 'bridge.mjs')
    const ctx = (b: string, br: string) =>
      ({ config, env: { ompBin: 'omp', claudeBin: b, claudeBridgeBin: br } }) as never
    registerSettingsIpc(ctx(bin, bridge), createWriteQueue())
    expect(handlers.get('chat.harnessStatus')!()).toEqual({ omp: true, claude: false })
    fs.writeFileSync(bin, '')
    fs.writeFileSync(bridge, '')
    expect(handlers.get('chat.harnessStatus')!()).toEqual({ omp: true, claude: true })
    fs.rmSync(bridge)
    expect(handlers.get('chat.harnessStatus')!()).toEqual({ omp: true, claude: false })
    vi.doUnmock('./ipc/handle')
  })
})
describe('index wiring', () => {
  it('registers every new handler', () => {
    const src = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    for (const n of [
      'registerLayoutIpc',
      'registerThemeIpc',
      'registerSettingsIpc',
      'registerEvaIpc',
      'installQuitGuard',
    ])
      expect(src).toContain(`${n}(`)
  })
})

describe('merge-write over a corrupt file', () => {
  it('backs up unparseable theme.json and chat.json instead of losing it silently', () => {
    fs.writeFileSync(path.join(dir, 'theme.json'), '{broken')
    saveLastBackground(config, '#112233')
    expect(fs.readFileSync(path.join(dir, 'theme.json.bad'), 'utf8')).toBe('{broken')
    expect(read('theme.json')).toMatchObject({ app: { lastBackground: '#112233' } })
    fs.writeFileSync(path.join(dir, 'chat.json'), '[1]')
    saveSettings(config, { show_tools: false })
    expect(fs.readFileSync(path.join(dir, 'chat.json.bad'), 'utf8')).toBe('[1]')
  })
  it('keeps unknown keys and does not back up a healthy file', () => {
    fs.writeFileSync(path.join(dir, 'theme.json'), '{"rustKey": 1}')
    saveAppearance(config, 'dark')
    expect(read('theme.json')).toMatchObject({ rustKey: 1, app: { appearance: 'dark' } })
    expect(fs.existsSync(path.join(dir, 'theme.json.bad'))).toBe(false)
  })
})
