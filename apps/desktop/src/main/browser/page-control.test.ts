import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { PageControl } from './page-control'

function fakeWebContents(result: unknown = { result: { value: 'ok' } }) {
  const wc = {
    loadURL: vi.fn(() => Promise.resolve()),
    debugger: {
      on: vi.fn(),
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      sendCommand: vi.fn(() => Promise.resolve(result)),
    },
  }
  return { wc, asWebContents: wc as unknown as WebContents }
}

describe('PageControl', () => {
  it('navigate() hands the URL to the host and never calls loadURL itself', () => {
    const { wc, asWebContents } = fakeWebContents()
    const load = vi.fn()
    const pc = new PageControl(asWebContents, load)
    pc.navigate('file:///etc/hosts')
    pc.navigate('https://example.com/')
    expect(load.mock.calls).toEqual([['file:///etc/hosts'], ['https://example.com/']])
    expect(wc.loadURL).not.toHaveBeenCalled()
  })

  it('evaluate() attaches lazily and surfaces page exceptions as errors', async () => {
    const { wc, asWebContents } = fakeWebContents({ exceptionDetails: { text: 'boom' } })
    wc.debugger.isAttached.mockReturnValueOnce(false)
    const pc = new PageControl(asWebContents, () => undefined)
    await expect(pc.evaluate('1 + 1')).rejects.toThrow('boom')
    expect(wc.debugger.attach).toHaveBeenCalledWith('1.3')
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: '1 + 1', returnByValue: true, awaitPromise: true }),
    )
  })
})
