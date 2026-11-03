import { describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(async () => ({ ok: true, value: {} }))
const handlers = new Map<string, (p: { id: string }) => void>()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => (invoke as (...x: unknown[]) => unknown)(...a),
  on: (c: string, cb: (p: { id: string }) => void) => {
    handlers.set(c, cb)
    return () => handlers.delete(c)
  },
}))

import { dirtyStore, listDirty, registerDirty, saveAllDirty } from './dirty-store'
import { startQuitBridge } from './quit-bridge'

describe('dirty registry', () => {
  it('registers, lists and unregisters', () => {
    const off = registerDirty('a', { label: 'File A', save: () => {} })
    expect(listDirty()).toEqual([{ id: 'a', label: 'File A' }])
    off()
    expect(listDirty()).toEqual([])
  })

  it('saves in order and reports every failure', async () => {
    const order: string[] = []
    const offs = [
      registerDirty('1', {
        label: 'one',
        save: () => {
          order.push('1')
          throw new Error('boom')
        },
      }),
      registerDirty('2', { label: 'two', save: () => void order.push('2') }),
      registerDirty('3', {
        label: 'three',
        save: async () => {
          order.push('3')
          throw new Error('x'.repeat(600))
        },
      }),
    ]
    const failures = await saveAllDirty()
    expect(order).toEqual(['1', '2', '3'])
    expect(failures.map((f) => f.id)).toEqual(['1', '3'])
    expect(failures[0]).toEqual({ id: '1', label: 'one', message: 'boom' })
    expect(failures[1]!.message.length).toBe(500)
    offs.forEach((o) => o())
    expect(dirtyStore.getState().entries.size).toBe(0)
  })
})

describe('quit bridge', () => {
  it('answers unsaved-edit and save requests with the request id', async () => {
    const off = registerDirty('f', { label: 'F', save: () => {} })
    const stop = startQuitBridge()
    handlers.get('app.unsavedEdits.request')!({ id: 'r1' })
    expect(invoke).toHaveBeenCalledWith('app.unsavedEdits.reply', {
      id: 'r1',
      entries: [{ id: 'f', label: 'F' }],
    })
    handlers.get('app.saveDirty.request')!({ id: 'r2' })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('app.saveDirty.reply', { id: 'r2', failures: [] }),
    )
    stop()
    off()
  })
})
