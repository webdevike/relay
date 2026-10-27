import { afterEach, describe, expect, it, vi } from 'vitest'

const showErrorBox = vi.fn()
vi.mock('electron', () => ({
  dialog: { showErrorBox: (t: string, m: string) => showErrorBox(t, m) },
}))

import { reportFatal } from './fatal'

afterEach(() => {
  showErrorBox.mockReset()
  vi.restoreAllMocks()
})

describe('reportFatal', () => {
  it('opens an error box for a visible instance', () => {
    reportFatal(false, 'Relay', 'boom')
    expect(showErrorBox).toHaveBeenCalledWith('Relay', 'boom')
  })

  it('prints to stderr and opens nothing for a hidden instance', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    reportFatal(true, 'Relay Dev', 'boom')
    expect(showErrorBox).not.toHaveBeenCalled()
    expect(write).toHaveBeenCalledWith('Relay Dev: boom\n')
  })
})
