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
  it('defaults true, saves partial, survives reload', () => {
    expect(saveSettings(config, { show_thinking: false })).toEqual({
      show_thinking: false,
      show_tools: true,
    })
    expect(loadSettings(createConfigStore(dir))).toEqual({ show_thinking: false, show_tools: true })
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
