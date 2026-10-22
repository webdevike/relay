import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfigStore } from '../config-store'
import { importNativeChatState, nativeConfigDir } from './native-import'

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-native-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const write = (dir: string, name: string, value: unknown): void =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value))
const read = (dir: string, name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))

const NATIVE_ORDER = {
  returned: { a: 10 },
  opened: { a: 11 },
  kept: { b: 12 },
  snoozed: { c: { until: 20, at: 13 } },
  woke: { d: 14 },
  collapsed: ['Relay'],
}

describe('importNativeChatState', () => {
  it('seeds a fresh config from the native files without touching them', () => {
    const native = tmp()
    const mine = tmp()
    write(native, 'chat-order.json', NATIVE_ORDER)
    write(native, 'chat.json', {
      archived_chats: ['x', 'y', 3],
      chat_agent: 'eren',
      harness: 'claude',
    })
    const before = [
      fs.readFileSync(path.join(native, 'chat-order.json'), 'utf8'),
      fs.readFileSync(path.join(native, 'chat.json'), 'utf8'),
    ]
    const config = createConfigStore(mine)
    expect(importNativeChatState(config, native)).toEqual({
      order: true,
      archived: true,
      agent: true,
    })
    const { collapsed: _collapsed, ...order } = NATIVE_ORDER
    expect(read(mine, 'chat-order.json')).toEqual(order)
    // Only the settled list and the agent tab come over; nothing else from the native chat.json.
    expect(read(mine, 'chat.json')).toEqual({ archived_chats: ['x', 'y'], chat_agent: 'Eren' })
    expect([
      fs.readFileSync(path.join(native, 'chat-order.json'), 'utf8'),
      fs.readFileSync(path.join(native, 'chat.json'), 'utf8'),
    ]).toEqual(before)
  })

  it('never overwrites existing Electron state', () => {
    const native = tmp()
    const mine = tmp()
    write(native, 'chat-order.json', NATIVE_ORDER)
    write(native, 'chat.json', { archived_chats: ['x'], chat_agent: 'Elysia' })
    write(mine, 'chat-order.json', { returned: { mine: 1 } })
    write(mine, 'chat.json', { archived_chats: [], chat_agent: 'Eva', collapsed_groups: ['Other'] })
    const config = createConfigStore(mine)
    expect(importNativeChatState(config, native)).toEqual({
      order: false,
      archived: false,
      agent: false,
    })
    expect(read(mine, 'chat-order.json')).toEqual({ returned: { mine: 1 } })
    expect(read(mine, 'chat.json')).toEqual({
      archived_chats: [],
      chat_agent: 'Eva',
      collapsed_groups: ['Other'],
    })
    // A key that is missing on its own is still seeded; the others stay.
    write(mine, 'chat.json', { chat_agent: 'Eva', collapsed_groups: ['Other'] })
    expect(importNativeChatState(config, native)).toEqual({
      order: false,
      archived: true,
      agent: false,
    })
    expect(read(mine, 'chat.json')).toEqual({
      chat_agent: 'Eva',
      collapsed_groups: ['Other'],
      archived_chats: ['x'],
    })
  })

  it('is fine without native files, or with unreadable ones', () => {
    const mine = tmp()
    const config = createConfigStore(mine)
    const none = { order: false, archived: false, agent: false }
    expect(importNativeChatState(config, path.join(mine, 'missing'))).toEqual(none)
    const bad = tmp()
    fs.writeFileSync(path.join(bad, 'chat-order.json'), '{not json')
    write(bad, 'chat.json', ['not', 'an', 'object'])
    expect(importNativeChatState(config, bad)).toEqual(none)
    expect(fs.readdirSync(mine)).toEqual([])
  })

  it('reads the native folder from EVAOS_NATIVE_CONFIG_DIR, else Application Support/EvaOS', () => {
    expect(nativeConfigDir({ EVAOS_NATIVE_CONFIG_DIR: '/n' })).toBe('/n')
    expect(nativeConfigDir({})).toBe(path.join(os.homedir(), 'Library/Application Support/EvaOS'))
  })
})
