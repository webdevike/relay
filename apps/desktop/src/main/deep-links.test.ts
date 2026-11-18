import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))
vi.mock('./ipc/handle', () => ({ emit: vi.fn(), handle: vi.fn() }))

import { linkInArgv } from './deep-links'

describe('linkInArgv', () => {
  it('finds the relay:// link a Linux launch carries', () => {
    expect(linkInArgv(['/nix/store/e/bin/electron', '/app', 'relay://open/canvas'])).toBe(
      'relay://open/canvas',
    )
    expect(linkInArgv(['/nix/store/e/bin/electron', '/app', '--enable-features=X'])).toBeNull()
    expect(linkInArgv(['electron', 'https://relay.example/'])).toBeNull()
  })
})
