import { describe, expect, it } from 'vitest'
import { defaultShell, spawnPathOf } from './shell-path'

describe('defaultShell', () => {
  it('uses $SHELL, else zsh where it exists, else /bin/sh (NixOS)', () => {
    expect(defaultShell({ SHELL: '/run/current-system/sw/bin/fish' }, () => true)).toBe(
      '/run/current-system/sw/bin/fish',
    )
    expect(defaultShell({}, (p) => p === '/bin/zsh')).toBe('/bin/zsh')
    expect(defaultShell({}, () => false)).toBe('/bin/sh')
  })
})

describe('spawnPathOf', () => {
  it('macOS: the login PATH as is', () => {
    expect(spawnPathOf('/opt/homebrew/bin:/usr/bin', '/usr/bin:/x', 'darwin')).toBe(
      '/opt/homebrew/bin:/usr/bin',
    )
  })

  it('Linux: keeps the launcher dirs a login profile dropped', () => {
    expect(
      spawnPathOf(
        '/run/current-system/sw/bin:/usr/bin',
        '/nix/store/a-relay-host/bin:/usr/bin:/nix/store/b-omp/bin',
        'linux',
      ),
    ).toBe('/run/current-system/sw/bin:/usr/bin:/nix/store/a-relay-host/bin:/nix/store/b-omp/bin')
  })

  it('falls back to the process PATH when the login shell gave none', () => {
    expect(spawnPathOf(null, '/usr/bin', 'linux')).toBe('/usr/bin')
    expect(spawnPathOf(null, '/usr/bin', 'darwin')).toBe('/usr/bin')
  })
})
