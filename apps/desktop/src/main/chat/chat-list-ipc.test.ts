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

import { createConfigStore, type ConfigStore } from '../config-store'
import { saveSettings } from '../settings-ipc'
import { createWriteQueue } from '../write-queue'
import { saveCollapsed } from './chat-list-ipc'

let dir: string
let config: ConfigStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-cl-'))
  config = createConfigStore(dir)
})
const read = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'))

describe('chat.setCollapsed', () => {
  it('writes collapsed_groups and keeps every other key', () => {
    fs.writeFileSync(
      path.join(dir, 'chat.json'),
      JSON.stringify({ show_thinking: true, harness: 'claude', zoom: 2 }),
    )
    expect(saveCollapsed(config, ['Other', 'Relay'])).toEqual({ saved: true })
    expect(read()).toEqual({
      show_thinking: true,
      harness: 'claude',
      zoom: 2,
      collapsed_groups: ['Other', 'Relay'],
    })
  })

  it('de-duplicates names and creates the file when missing', () => {
    saveCollapsed(config, ['Other', 'Other', 'Eva'])
    expect(read().collapsed_groups).toEqual(['Other', 'Eva'])
  })

  it('runs through the queue in order alongside settings writes', async () => {
    const q = createWriteQueue()
    await Promise.all([
      q.enqueue(() => saveCollapsed(config, ['Other'])),
      q.enqueue(() => saveSettings(config, { show_thinking: true })),
      q.enqueue(() => saveCollapsed(config, ['Other', 'Eva'])),
    ])
    expect(read()).toMatchObject({ collapsed_groups: ['Other', 'Eva'], show_thinking: true })
  })
})
