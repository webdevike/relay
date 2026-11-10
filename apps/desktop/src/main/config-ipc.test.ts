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
import { loadTheme, readLastBackground, saveLastBackground, saveTheme } from './theme-ipc'
import { loadSettings, saveSettings, seedFavorites } from './settings-ipc'
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
      tabs: null,
      dock: null,
      workspaces: null,
      tiling: null,
      legacyPanel: null,
      sidebar: null,
      ui: null,
      reset: false,
    })
    fs.writeFileSync(path.join(dir, 'layout.json'), '{not json')
    expect(loadLayout(config)).toMatchObject({ sidebarWidth: 272, reset: true })
    fs.writeFileSync(path.join(dir, 'layout.json'), '{"sidebar_width": 9999}')
    expect(loadLayout(config).sidebarWidth).toBe(420)
  })
  it('merge-writes, keeping unknown keys, through the queue in order', async () => {
    fs.writeFileSync(path.join(dir, 'layout.json'), '{"zoom": 2}')
    const q = createWriteQueue()
    const tabs = { active: 0, list: [] }
    const dock = { grid: { root: { type: 'branch', data: [], size: 1 } }, panels: {} }
    await Promise.all([
      q.enqueue(() => saveLayout(config, { sidebarWidth: 300.4, tabs })),
      q.enqueue(() => saveLayout(config, { dock })),
    ])
    expect(read('layout.json')).toMatchObject({
      sidebar_width: 300,
      dock,
      zoom: 2,
      tabs,
    })
  })
  it('seeds from the old panel, then the split tree, until a dock is saved', () => {
    fs.writeFileSync(
      path.join(dir, 'layout.json'),
      '{"panel_width": 500, "panel_tool": "files", "panel_choices": {"chat:/a": true}}',
    )
    expect(loadLayout(config)).toMatchObject({
      dock: null,
      tiling: null,
      legacyPanel: { width: 500, tool: 'files' },
    })
    const tiling = { root: { type: 'pane', id: 'chat', tabs: [], active: null } }
    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify({ panel_width: 500, tiling }))
    expect(loadLayout(config)).toMatchObject({ tiling, legacyPanel: null })
    const dock = { grid: { root: { type: 'branch', data: [], size: 1 } }, panels: {} }
    saveLayout(config, { dock })
    expect(loadLayout(config)).toMatchObject({ dock, tiling: null, legacyPanel: null })
    expect(read('layout.json')).not.toHaveProperty('tiling')
    expect(read('layout.json')).not.toHaveProperty('panel_width')
  })
  it('keeps the sidebar customization across dock saves and reloads', () => {
    const sidebar = { badgeStyle: 'dot', visibility: { jobs: 'badged' }, favorites: [] }
    saveLayout(config, { sidebar })
    saveLayout(config, { sidebarWidth: 280 })
    expect(loadLayout(config)).toMatchObject({ sidebar, sidebarWidth: 280 })
    expect(read('layout.json')).toHaveProperty('sidebar', sidebar)
  })
  it('queue survives a rejected task', async () => {
    const q = createWriteQueue()
    await expect(q.enqueue(() => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(q.enqueue(() => 5)).resolves.toBe(5)
  })
})

describe('theme', () => {
  const saved = { config: { primaryColor: 'teal', colorScheme: 'dark' }, preset: 'custom' }

  it('persists the last background', () => {
    expect(readLastBackground(config)).toBe('#181817')
    saveLastBackground(config, '#222222')
    expect(readLastBackground(config)).toBe('#222222')
  })

  it('loads nothing until a preset config is saved, including from the older theme format', () => {
    expect(loadTheme(config)).toEqual({ theme: null })
    fs.writeFileSync(
      path.join(dir, 'theme.json'),
      '{"base":"Flexoki","light":{"edits":{}},"app":{"appearance":"dark"}}',
    )
    expect(loadTheme(config)).toEqual({ theme: null })
  })

  it('replaces an older theme format, keeps app state, and survives a new store', async () => {
    fs.writeFileSync(
      path.join(dir, 'theme.json'),
      JSON.stringify({ base: 'EvaOS', shared: { radius: 3 }, app: { lastBackground: '#111111' } }),
    )
    const queue = createWriteQueue()
    await Promise.all([
      queue.enqueue(() => saveTheme(config, saved)),
      queue.enqueue(() => saveLastBackground(config, '#222222')),
    ])
    expect(read('theme.json')).toEqual({ ...saved, app: { lastBackground: '#222222' } })
    expect(loadTheme(createConfigStore(dir))).toEqual({ theme: saved })
  })
})

describe('settings', () => {
  it('defaults follow Rust: thinking off, tools off, harness omp', () => {
    expect(loadSettings(config)).toEqual({
      show_thinking: false,
      show_tools: false,
      harness: 'omp',
      favorite_models: [],
    })
  })
  it('chat.json wins, settings.json fills missing keys', () => {
    fs.writeFileSync(
      path.join(dir, 'chat.json'),
      '{"show_thinking":true,"chat_categories":["X"],"favorite_models":["a/b",3]}',
    )
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"show_tools":false,"show_thinking":false}')
    expect(loadSettings(config)).toEqual({
      show_thinking: true,
      show_tools: false,
      harness: 'omp',
      favorite_models: ['a/b'],
    })
  })
  it('save writes chat.json, keeps unknown keys, never touches settings.json', () => {
    fs.writeFileSync(path.join(dir, 'chat.json'), '{"chat_categories":["X"],"zoom":2}')
    const legacy = '{"show_tools":false}'
    fs.writeFileSync(path.join(dir, 'settings.json'), legacy)
    expect(saveSettings(config, { harness: 'claude' })).toEqual({
      show_thinking: false,
      show_tools: false,
      harness: 'claude',
      favorite_models: [],
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
      favorite_models: [],
    })
  })
  it('seeds starred models once from native EvaOS when chat.json has no key', () => {
    const native = path.join(dir, 'native.json')
    const nativeText = '{"favorite_models":["anthropic/claude-opus-5-5","x/y"],"zoom":3}'
    fs.writeFileSync(native, nativeText)
    fs.writeFileSync(path.join(dir, 'chat.json'), '{"harness":"claude"}')
    seedFavorites(config, native)
    expect(read('chat.json')).toEqual({
      harness: 'claude',
      favorite_models: ['anthropic/claude-opus-5-5', 'x/y'],
    })
    // The native file is only read.
    expect(fs.readFileSync(native, 'utf8')).toBe(nativeText)
  })
  it('leaves an existing favorite_models key alone, even an empty one', () => {
    const native = path.join(dir, 'native.json')
    fs.writeFileSync(native, '{"favorite_models":["a/b"]}')
    fs.writeFileSync(path.join(dir, 'chat.json'), '{"favorite_models":[]}')
    seedFavorites(config, native)
    expect(read('chat.json')).toEqual({ favorite_models: [] })
    // No native file (dev, tests) or an unreadable one: nothing is written.
    fs.rmSync(path.join(dir, 'chat.json'))
    seedFavorites(config, null)
    seedFavorites(config, path.join(dir, 'missing.json'))
    expect(fs.existsSync(path.join(dir, 'chat.json'))).toBe(false)
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
    saveLastBackground(config, '#112233')
    expect(read('theme.json')).toMatchObject({ rustKey: 1, app: { lastBackground: '#112233' } })
    expect(fs.existsSync(path.join(dir, 'theme.json.bad'))).toBe(false)
  })
})
