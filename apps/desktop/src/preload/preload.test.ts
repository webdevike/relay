import { describe, expect, it, vi } from 'vitest'
import { createEvaBridge } from './bridge'

const makeIpc = () => ({ invoke: vi.fn(async () => 'x'), on: vi.fn(), removeListener: vi.fn() })

describe('preload bridge', () => {
  it('rejects unknown channels without calling ipcRenderer', async () => {
    const ipc = makeIpc()
    const eva = createEvaBridge(ipc)
    await expect(eva.invoke('nope', {})).rejects.toThrow(/unknown channel/)
    expect(ipc.invoke).not.toHaveBeenCalled()
  })

  it('forwards known channels', async () => {
    const ipc = makeIpc()
    const eva = createEvaBridge(ipc)
    await expect(eva.invoke('app.info', {})).resolves.toBe('x')
    expect(ipc.invoke).toHaveBeenCalledWith('app.info', {})
  })

  it('refuses to subscribe to unknown event channels', () => {
    expect(() => createEvaBridge(makeIpc()).on('nope', () => {})).toThrow(/unknown channel/)
  })
})
