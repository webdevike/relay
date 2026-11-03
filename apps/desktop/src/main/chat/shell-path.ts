import { execFile } from 'node:child_process'

let cached: Promise<string> | null = null

/**
 * GUI-launched macOS apps do not inherit the shell PATH. In live mode the login shell's PATH is
 * resolved once and cached; in fixture mode the process PATH is used as is.
 */
export function resolveSpawnPath(live: boolean): Promise<string> {
  const fallback = process.env.PATH ?? ''
  if (!live) return Promise.resolve(fallback)
  cached ??= new Promise<string>((resolve) => {
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', 'echo -n "$PATH"'],
      // An interactive zsh ignores SIGTERM; without SIGKILL a slow rc file hangs app launch forever.
      { timeout: 3000, killSignal: 'SIGKILL' },
      (error, stdout) => {
        resolve(!error && stdout.trim() !== '' ? stdout.trim() : fallback)
      },
    )
  })
  return cached
}
