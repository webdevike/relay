// Relay Assist (apps/assist) ships inside the packaged app, `Relay.app/Contents/Helpers/Relay
// Assist.app`, and runs as Relay's child. macOS charges a child's Screen Recording,
// Accessibility and Microphone use to its responsible process, so Isaac grants them once, to
// "Relay". relay-desktop-deploy.ts signs the app and Assist with one stable identity, so the
// grants survive every self-update (update/packaged.ts refuses a bundle signed otherwise).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** A crash restarts Assist after this long. */
export const RESTART_MS = 5_000
/** A run shorter than this that ends in a crash counts toward giving up. */
export const SHORT_RUN_MS = 60_000
/** Crashes in a row, each within SHORT_RUN_MS of its start, after which Assist stays down. */
export const MAX_QUICK_CRASHES = 5

/** The Assist executable in a packaged Relay.app, from its `Contents/Resources`. */
export function assistExecutable(resourcesPath: string): string {
  return path.join(
    resourcesPath,
    '..',
    'Helpers',
    'Relay Assist.app',
    'Contents',
    'MacOS',
    'RelayBuddy',
  )
}

export interface AssistRunner {
  /** Ends Assist (SIGTERM) and resolves once it is gone or after 3 s. */
  stop(): Promise<void>
}

/**
 * Keeps Assist running while Relay runs: a crash restarts it, a clean exit (its Quit menu item,
 * or a newer copy taking over) leaves it down until Relay starts again. Null when this build
 * carries no Assist.
 */
export function startAssist(
  executable: string,
  log: (msg: string) => void = () => undefined,
): AssistRunner | null {
  if (!existsSync(executable)) return null
  let child: ChildProcess | null = null
  let stopped = false
  let quickCrashes = 0
  let timer: NodeJS.Timeout | undefined

  const launch = (): void => {
    const started = Date.now()
    // A plain spawn (no LaunchServices) keeps Relay the responsible process for the grants.
    const c = spawn(executable, [], { stdio: 'ignore' })
    child = c
    c.on('error', (e) => log(`assist: ${e.message}`))
    c.on('exit', (code, signal) => {
      child = null
      if (stopped) return
      if (code === 0) {
        log('assist exited cleanly; not restarting')
        return
      }
      quickCrashes = Date.now() - started < SHORT_RUN_MS ? quickCrashes + 1 : 1
      if (quickCrashes >= MAX_QUICK_CRASHES) {
        log(
          `assist crashed ${quickCrashes} times in a row (last ${signal ?? code}); leaving it down`,
        )
        return
      }
      log(`assist ended (${signal ?? code}); restarting in ${RESTART_MS / 1000} s`)
      timer = setTimeout(launch, RESTART_MS)
    })
  }
  launch()

  return {
    stop() {
      stopped = true
      clearTimeout(timer)
      const c = child
      if (!c) return Promise.resolve()
      const { promise, resolve } = Promise.withResolvers<void>()
      const cap = setTimeout(resolve, 3_000)
      c.once('exit', () => {
        clearTimeout(cap)
        resolve()
      })
      c.kill('SIGTERM')
      return promise
    },
  }
}
