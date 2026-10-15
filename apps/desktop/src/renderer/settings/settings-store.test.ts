import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const show = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import {
  SAVE_ERROR_COPY,
  resetSettingsForTest,
  setSetting,
  settingsStore,
  startSettings,
} from './settings-store'

beforeEach(() => {
  invoke.mockReset()
  show.mockReset()
  resetSettingsForTest()
})

describe('settings store', () => {
  it('defaults true, applies load, tolerates failed load', async () => {
    expect(settingsStore.getState()).toMatchObject({ show_thinking: true, show_tools: true })
    invoke.mockResolvedValue({ ok: true, value: { show_thinking: false, show_tools: true } })
    await startSettings()
    expect(settingsStore.getState()).toMatchObject({ show_thinking: false, loaded: true })
    resetSettingsForTest()
    invoke.mockRejectedValue(new Error('x'))
    await startSettings()
    expect(settingsStore.getState()).toMatchObject({
      show_thinking: true,
      show_tools: true,
      loaded: true,
    })
  })

  it('saves optimistically and adopts the merged value', async () => {
    let release!: (v: unknown) => void
    invoke.mockReturnValue(new Promise((r) => (release = r)))
    const p = setSetting('show_thinking', false)
    expect(settingsStore.getState().show_thinking).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('settings.save', { show_thinking: false })
    release({ ok: true, value: { show_thinking: false, show_tools: true } })
    await p
    expect(settingsStore.getState().show_thinking).toBe(false)
  })

  it('reverts and toasts on an error result or a throw', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: { message: 'no' } })
    await setSetting('show_tools', false)
    expect(settingsStore.getState().show_tools).toBe(true)
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: SAVE_ERROR_COPY }))
    expect(SAVE_ERROR_COPY).toBe(
      'Could not save your settings. Check that the EvaOS config folder is writable, then try again.',
    )
    invoke.mockRejectedValueOnce(new Error('boom'))
    await setSetting('show_tools', false)
    expect(settingsStore.getState().show_tools).toBe(true)
    expect(show).toHaveBeenCalledTimes(2)
  })

  it('serialises quick toggles in order', async () => {
    const order: boolean[] = []
    invoke.mockImplementation(async (_c: string, input: { show_thinking: boolean }) => {
      order.push(input.show_thinking)
      await new Promise((r) => setTimeout(r, order.length === 1 ? 20 : 0))
      return { ok: true, value: { show_thinking: input.show_thinking, show_tools: true } }
    })
    const a = setSetting('show_thinking', false)
    const b = setSetting('show_thinking', true)
    await Promise.all([a, b])
    expect(order).toEqual([false, true])
    expect(settingsStore.getState().show_thinking).toBe(true)
  })
})
