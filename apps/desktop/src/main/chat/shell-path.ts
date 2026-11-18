import { execFile } from 'node:child_process'
import * as fs from 'node:fs'

let cached: Promise<string> | null = null

/** `$SHELL`, else zsh where it exists (macOS), else `/bin/sh` (NixOS has no `/bin/zsh`). */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  if (env.SHELL) return env.SHELL
  return exists('/bin/zsh') ? '/bin/zsh' : '/bin/sh'
}

/**
 * The PATH children get: the login shell's (`login`, null when it gave none), else `own`. Off
 * macOS `own` dirs the login PATH lacks follow it: the Nix launcher appends relay-host, omp,
 * herdr and bun to the app's PATH, and a login profile (/etc/profile) sets PATH anew.
 */
export function spawnPathOf(
  login: string | null,
  own: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (login === null) return own
  if (platform === 'darwin') return login
  const dirs = [...login.split(':'), ...own.split(':')].filter((d) => d !== '')
  return [...new Set(dirs)].join(':')
}

/**
 * GUI-launched macOS apps do not inherit the shell PATH. In live mode the login shell's PATH is
 * resolved once and cached; in fixture mode the process PATH is used as is.
 */
export function resolveSpawnPath(live: boolean): Promise<string> {
  const fallback = process.env.PATH ?? ''
  if (!live) return Promise.resolve(fallback)
  cached ??= new Promise<string>((resolve) => {
    execFile(
      defaultShell(),
      ['-ilc', 'echo -n "$PATH"'],
      // An interactive zsh ignores SIGTERM; without SIGKILL a slow rc file hangs app launch forever.
      { timeout: 3000, killSignal: 'SIGKILL' },
      (error, stdout) => {
        resolve(spawnPathOf(!error && stdout.trim() !== '' ? stdout.trim() : null, fallback))
      },
    )
  })
  return cached
}
