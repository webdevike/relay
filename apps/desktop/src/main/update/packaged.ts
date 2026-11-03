import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { ChangelogEntrySchema, type ChangelogEntry, type UpdateCheckStatus } from '@evaos/contract'

const run = promisify(execFile)

/** How often the app looks for a newer build; the first look is a little after launch. */
export const CHECK_EVERY_MS = 5 * 60_000
export const FIRST_CHECK_MS = 20_000

/**
 * `<configDir>/update-now`: relay-desktop-deploy.ts touches it over ssh right after publishing a
 * build, so the app checks at once instead of at the next poll. Consumed (deleted) on use.
 */
export const KICK_FILE = 'update-now'

/** Calls `onKick` whenever KICK_FILE appears in `dir` (also if it was already there), deleting it first. */
export function watchKick(dir: string, onKick: () => void): () => void {
  const file = path.join(dir, KICK_FILE)
  const take = (): void => {
    if (!existsSync(file)) return
    rmSync(file, { force: true })
    onKick()
  }
  const w = watch(dir, (_event, name) => {
    if (name === null || name === KICK_FILE) take()
  })
  w.on('error', () => undefined)
  take()
  return () => w.close()
}

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

/**
 * `<dir>/history.json`: every deploy relay-desktop-deploy.ts made and every Relay Host install it
 * recorded, as an array of ChangelogEntry. Entries that do not parse are skipped; the rest come
 * back newest first.
 */
export function parseHistory(raw: unknown): ChangelogEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: ChangelogEntry[] = []
  for (const item of raw) {
    const r = ChangelogEntrySchema.safeParse(item)
    if (r.success && !Number.isNaN(Date.parse(r.data.at))) entries.push(r.data)
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

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
 * The designated requirement `bundle` is signed with (`codesign -d -r-`), e.g.
 * `identifier "dev.eva.relay-desktop" and certificate leaf = H"..."`; null when unsigned.
 */
export async function requirementOf(bundle: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await run('codesign', ['-d', '-r-', bundle], { timeout: 30_000 })
    return /designated => (.+)/.exec(stdout + stderr)?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

/**
 * Whether a bundle signed with `staged` keeps the privacy grants (Screen Recording,
 * Accessibility, Microphone) macOS gave the app signed with `current`: TCC stores the
 * designated requirement, so a stably signed app only takes a bundle with the same one. An
 * ad-hoc app (`cdhash ...`, new every build) has no grants to keep and takes any bundle, which
 * is how it moves to the stable identity once.
 */
export function keepsIdentity(current: string | null, staged: string | null): boolean {
  return current === null || current.startsWith('cdhash ') || current === staged
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
  /** Looks for a newer build now, as a deploy's kick does, and says what it found. */
  checkNow(): Promise<UpdateCheckStatus>
  /** The source's deploy history, newest first; empty without a source or when it cannot be read. */
  changelog(): Promise<ChangelogEntry[]>
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
  /** A kick arrived mid-check (maybe before the new latest.json was read): look once more after. */
  let again = false
  /** A build whose signature would drop this app's privacy grants; not fetched again this run. */
  let rejected: string | null = null
  let timer: NodeJS.Timeout | undefined

  const readStaged = (): Staged | null => {
    try {
      const s = JSON.parse(readFileSync(stagedMarker, 'utf8')) as Partial<Staged>
      return typeof s.build === 'string' && existsSync(stagedApp) ? { build: s.build } : null
    } catch {
      return null
    }
  }

  /** A file the source keeps next to latest.json: read locally, or over ssh from the Mini. */
  async function sourceFile(src: UpdateSource, name: string): Promise<string> {
    const file = path.posix.join(src.dir, name)
    return src.ssh
      ? (
          await run(
            'ssh',
            ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', src.ssh, 'cat', JSON.stringify(file)],
            { timeout: 20_000 },
          )
        ).stdout
      : readFileSync(file, 'utf8')
  }

  async function latest(src: UpdateSource): Promise<Latest | null> {
    const r = LatestSchema.safeParse(JSON.parse(await sourceFile(src, 'latest.json')))
    return r.success ? r.data : null
  }

  async function check(): Promise<UpdateCheckStatus> {
    if (checking) {
      again = true
      return 'busy'
    }
    checking = true
    let status: UpdateCheckStatus = 'failed'
    try {
      const src = readSource(opts.configDir)
      const mine = ownBuild(opts.appPath)
      if (!src || !mine) return (status = 'unavailable')
      const l = await latest(src)
      if (!l) return status
      if (l.build === mine) return (status = 'current')
      if (l.build === rejected) return (status = 'failed')
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
        // A bundle that fails its own signature would not launch; one signed with another
        // identity would launch without the grants Isaac gave this one.
        await run('codesign', ['--verify', '--deep', '--strict', stagedApp], {
          timeout: 5 * 60_000,
        })
        const current = await requirementOf(bundleOf(opts.execPath))
        const staged = await requirementOf(stagedApp)
        if (!keepsIdentity(current, staged)) {
          rejected = l.build
          log(`update ${l.build} skipped: signed as ${staged ?? 'nothing'}, this app is ${current}`)
          return status
        }
        writeFileSync(stagedMarker, JSON.stringify({ build: l.build }))
      }
      opts.offer({ summary: l.summary ?? `Build ${l.build}`, build: l.build })
      return (status = 'ready')
    } catch (e) {
      log(`update check failed: ${e instanceof Error ? e.message : String(e)}`)
      return status
    } finally {
      checking = false
      if (again) {
        again = false
        void check()
      }
    }
  }

  async function changelog(): Promise<ChangelogEntry[]> {
    const src = readSource(opts.configDir)
    if (!src) return []
    try {
      return parseHistory(JSON.parse(await sourceFile(src, 'history.json')))
    } catch (e) {
      log(`deploy history unavailable: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  return {
    start() {
      if (!readSource(opts.configDir) || !ownBuild(opts.appPath)) return
      setTimeout(() => void check(), FIRST_CHECK_MS).unref()
      timer = setInterval(() => void check(), CHECK_EVERY_MS)
      timer.unref()
      try {
        mkdirSync(opts.configDir, { recursive: true })
        watchKick(opts.configDir, () => {
          log('update check requested by a deploy')
          if (checking) again = true
          else void check()
        })
      } catch (e) {
        log(`update kick watcher unavailable: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    checkNow: () => check(),
    changelog,
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
