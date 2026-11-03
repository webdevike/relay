import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const run = promisify(execFile)

/** How often the app looks for a newer build; the first look is a little after launch. */
export const CHECK_EVERY_MS = 5 * 60_000
export const FIRST_CHECK_MS = 20_000

/**
 * Where new builds come from, `<configDir>/update-source.json`. `ssh` (optional) is a
 * `user@host` the folder lives on (a thin-client Mac pulling from the Mini); without it `dir`
 * is a local folder. Absent file: this app never self-updates (Relay Dev, tests).
 */
export const UpdateSourceSchema = z.object({
  ssh: z.string().min(1).optional(),
  dir: z.string().min(1),
})
export type UpdateSource = z.infer<typeof UpdateSourceSchema>

/** `<dir>/latest.json`, written by relay-desktop-deploy.ts once a packaged build is in place. */
export const LatestSchema = z.object({
  build: z.string().min(1).max(64),
  summary: z.string().max(200).nullable().default(null),
  /** The .app folder under `dir`, e.g. `<sha>/Relay.app`. */
  app: z.string().min(1),
})
export type Latest = z.infer<typeof LatestSchema>

export function readSource(configDir: string): UpdateSource | null {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(configDir, 'update-source.json'), 'utf8'),
    )
    const r = UpdateSourceSchema.safeParse(raw)
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** The build a packaged app was made from: `relayBuild` in its package.json (deploy sets it). */
export function ownBuild(appPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(appPath, 'package.json'), 'utf8')) as {
      relayBuild?: unknown
    }
    return typeof pkg.relayBuild === 'string' ? pkg.relayBuild : null
  } catch {
    return null
  }
}

/** `/Applications/Relay.app` from the running executable `.../Relay.app/Contents/MacOS/Relay`. */
export function bundleOf(execPath: string): string {
  return path.resolve(execPath, '..', '..', '..')
}

/**
 * The shell that swaps the staged bundle in once this process is gone and opens it. It clones
 * (APFS) the staged copy next to the old bundle so a failed copy leaves the old app in place,
 * and reopens the old app if the final move fails.
 */
export function swapScript(): string {
  return [
    'pid="$1"; staged="$2"; dest="$3"',
    'while kill -0 "$pid" 2>/dev/null; do sleep 0.3; done',
    'new="$dest.new"; old="$dest.old"',
    'rm -rf "$new" "$old"',
    '{ cp -cR "$staged" "$new" || cp -R "$staged" "$new"; } || { open "$dest"; exit 1; }',
    'if mv "$dest" "$old" && mv "$new" "$dest"; then rm -rf "$old"; else',
    '  [ -d "$dest" ] || mv "$old" "$dest"; rm -rf "$new"',
    'fi',
    'open "$dest"',
  ].join('\n')
}

export interface PackagedUpdater {
  start(): void
  /** True when a staged bundle will be swapped in after this process exits (call right before quitting). */
  scheduleSwap(): boolean
}

interface Staged {
  build: string
}

/**
 * Self-update of a packaged app: poll the source, rsync a newer bundle into
 * `<configDir>/updates/Relay.app` (incremental after the first time), then offer it through the
 * normal update toast. The restart path calls `scheduleSwap` so the new bundle replaces this one
 * and opens by itself.
 */
export function createPackagedUpdater(opts: {
  configDir: string
  appPath: string
  execPath: string
  pid: number
  offer(u: { summary: string; build: string }): void
  log?(msg: string): void
}): PackagedUpdater {
  const stageDir = path.join(opts.configDir, 'updates')
  const stagedApp = path.join(stageDir, 'Relay.app')
  const stagedMarker = path.join(stageDir, 'staged.json')
  const log = opts.log ?? (() => undefined)
  let checking = false
  let timer: NodeJS.Timeout | undefined

  const readStaged = (): Staged | null => {
    try {
      const s = JSON.parse(readFileSync(stagedMarker, 'utf8')) as Partial<Staged>
      return typeof s.build === 'string' && existsSync(stagedApp) ? { build: s.build } : null
    } catch {
      return null
    }
  }

  async function latest(src: UpdateSource): Promise<Latest | null> {
    const file = path.posix.join(src.dir, 'latest.json')
    const text = src.ssh
      ? (
          await run(
            'ssh',
            ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', src.ssh, 'cat', JSON.stringify(file)],
            { timeout: 20_000 },
          )
        ).stdout
      : readFileSync(file, 'utf8')
    const r = LatestSchema.safeParse(JSON.parse(text))
    return r.success ? r.data : null
  }

  async function check(): Promise<void> {
    if (checking) return
    checking = true
    try {
      const src = readSource(opts.configDir)
      const mine = ownBuild(opts.appPath)
      if (!src || !mine) return
      const l = await latest(src)
      if (!l || l.build === mine) return
      const have = readStaged()
      if (have?.build !== l.build) {
        mkdirSync(stageDir, { recursive: true })
        rmSync(stagedMarker, { force: true })
        const from = path.posix.join(src.dir, l.app) + '/'
        await run(
          'rsync',
          [
            '-a',
            '--delete',
            ...(src.ssh ? ['-e', 'ssh -o BatchMode=yes -o ConnectTimeout=8'] : []),
            src.ssh ? `${src.ssh}:${from}` : from,
            stagedApp + '/',
          ],
          { timeout: 20 * 60_000 },
        )
        writeFileSync(stagedMarker, JSON.stringify({ build: l.build }))
      }
      opts.offer({ summary: l.summary ?? `Build ${l.build}`, build: l.build })
    } catch (e) {
      log(`update check failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      checking = false
    }
  }

  return {
    start() {
      if (!readSource(opts.configDir) || !ownBuild(opts.appPath)) return
      setTimeout(() => void check(), FIRST_CHECK_MS).unref()
      timer = setInterval(() => void check(), CHECK_EVERY_MS)
      timer.unref()
    },
    scheduleSwap() {
      const staged = readStaged()
      if (!staged || staged.build === ownBuild(opts.appPath)) return false
      const child = spawn(
        '/bin/sh',
        ['-c', swapScript(), 'relay-swap', String(opts.pid), stagedApp, bundleOf(opts.execPath)],
        { detached: true, stdio: 'ignore' },
      )
      child.unref()
      return true
    },
  }
}
