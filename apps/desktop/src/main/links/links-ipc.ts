import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { shell } from 'electron'
import {
  DEFAULT_LINK_PREFS,
  LinkPrefsSchema,
  resolveLink,
  seedLinkPrefs,
  type LinkPrefs,
  type LinkRoute,
} from '@evaos/contract'
import type { ConfigStore } from '../config-store'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { registerTestHook } from '../test-hooks'
import type { WriteQueue } from '../write-queue'

/** Settings > Links, in the config folder. Missing or invalid: the defaults. */
export const LINKS_FILE = 'links.json'

/** The saved rules, with default rule sets added since they were saved (`seedLinkPrefs`). */
export function loadLinkPrefs(config: ConfigStore): LinkPrefs {
  const parsed = LinkPrefsSchema.safeParse(config.readJson<unknown>(LINKS_FILE, null))
  return parsed.success ? seedLinkPrefs(parsed.data) : DEFAULT_LINK_PREFS
}

/** Where apps live; each `<Name>.app` directly inside is an app an opener can name. */
export function appDirs(home = os.homedir()): string[] {
  return [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    '/System/Volumes/Preboot/Cryptexes/App/System/Applications',
    path.join(home, 'Applications'),
  ]
}

/** Installed app names (`Arc`, `Linear`), sorted, without duplicates. */
export function installedApps(dirs: readonly string[]): string[] {
  const names = new Set<string>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries) if (e.endsWith('.app') && !e.startsWith('.')) names.add(e.slice(0, -4))
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}

/** Linux: the XDG application folders, the user's first (it shadows the system's). */
export function xdgAppDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local/share')
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [dataHome, ...dataDirs].map((d) => path.join(d, 'applications'))
}

/**
 * Linux apps that open a URL: each visible `.desktop` entry whose Exec takes one (`%u`/`%U`), by
 * its Name, with that Exec line. The first folder with a name wins.
 */
export function desktopApps(dirs: readonly string[]): Map<string, string> {
  const apps = new Map<string, string>()
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const e of entries.sort()) {
      if (!e.endsWith('.desktop')) continue
      let text: string
      try {
        text = fs.readFileSync(path.join(dir, e), 'utf8')
      } catch {
        continue
      }
      const entry = desktopEntry(text)
      if (entry && !apps.has(entry.name)) apps.set(entry.name, entry.exec)
    }
  }
  return apps
}

function desktopEntry(text: string): { name: string; exec: string } | null {
  const keys = new Map<string, string>()
  let inEntry = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    const eq = line.indexOf('=')
    if (!inEntry || eq <= 0 || line.startsWith('#')) continue
    const key = line.slice(0, eq).trim()
    if (!keys.has(key)) keys.set(key, line.slice(eq + 1).trim())
  }
  const name = keys.get('Name')
  const exec = keys.get('Exec')
  if (!name || !exec || keys.get('Type') !== 'Application') return null
  if (keys.get('NoDisplay') === 'true' || keys.get('Hidden') === 'true') return null
  return /%[uU]/.test(exec) ? { name, exec } : null
}

/**
 * A desktop entry's Exec line as argv with `url` for its URL field code (Desktop Entry spec:
 * double-quoted arguments with backslash escapes; `%f %F %u %U` take the URL, `%%` is a literal
 * percent, the other field codes drop).
 */
export function execArgv(exec: string, url: string): string[] {
  const words: string[] = []
  let word: string | null = null
  let quoted = false
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i]!
    if (quoted) {
      if (ch === '"') quoted = false
      else if (ch === '\\' && i + 1 < exec.length) word += exec[++i]!
      else word += ch
    } else if (ch === '"') {
      quoted = true
      word ??= ''
    } else if (ch === ' ' || ch === '\t') {
      if (word !== null) words.push(word)
      word = null
    } else {
      word = (word ?? '') + ch
    }
  }
  if (word !== null) words.push(word)
  const out: string[] = []
  for (const w of words) {
    if (/^%[fFuU]$/.test(w)) out.push(url)
    else if (/^%[a-zA-Z]$/.test(w)) continue
    else out.push(w.replace(/%%/g, '%'))
  }
  return out
}

export type Launcher = (
  route: Exclude<LinkRoute, { to: 'none' } | { to: 'browser' } | { to: 'reviews' }>,
) => Promise<boolean>

/** The system's handler for the URL (a browser, or the app that claims its scheme). */
const openExternal = (url: string): Promise<boolean> =>
  shell.openExternal(url).then(
    () => true,
    () => false,
  )

/** Launches outside Relay: `open -a <app> <url>`, else the system's handler for the URL. */
export const launchRoute: Launcher = (route) => {
  if (route.to === 'app') {
    return new Promise((resolve) => {
      execFile('/usr/bin/open', ['-a', route.app, route.url], (err) => resolve(!err))
    })
  }
  return openExternal(route.url)
}

/** Linux: an app route runs that desktop entry's Exec with the URL, detached from Relay. */
export function linuxLauncher(execOf: (app: string) => string | undefined): Launcher {
  return (route) => {
    if (route.to !== 'app') return openExternal(route.url)
    const exec = execOf(route.app)
    const argv = exec ? execArgv(exec, route.url) : []
    if (argv.length === 0) return Promise.resolve(false)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' })
    child.once('error', () => resolve(false))
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
    return promise
  }
}

export function registerLinksIpc(
  ctx: MainContext,
  queue: WriteQueue,
  opts: { dirs?: string[]; launch?: Launcher; platform?: NodeJS.Platform } = {},
): void {
  const mac = (opts.platform ?? process.platform) === 'darwin'
  const dirs = opts.dirs ?? (mac ? appDirs() : xdgAppDirs())
  // Linux: the desktop entries last listed, by name, to launch from.
  let entries = new Map<string, string>()
  const scan = (): string[] => {
    if (mac) return installedApps(dirs)
    entries = desktopApps(dirs)
    return [...entries.keys()].sort((a, b) => a.localeCompare(b))
  }
  // Test instances never launch anything: each launch is recorded for the spec instead.
  const launches: unknown[] = []
  if (ctx.env.e2e) registerTestHook('linkLaunches', launches)
  const launch: Launcher =
    opts.launch ??
    (ctx.env.e2e
      ? (route) => {
          launches.push(route)
          return Promise.resolve(true)
        }
      : mac
        ? launchRoute
        : linuxLauncher((app) => entries.get(app)))
  let apps = scan()
  const state = (): { prefs: LinkPrefs; apps: string[] } => ({
    prefs: loadLinkPrefs(ctx.config),
    apps,
  })
  handle(ctx, 'links.get', () => {
    apps = scan()
    return state()
  })
  handle(ctx, 'links.set', ({ prefs }) =>
    queue.enqueue(() => {
      ctx.config.writeJson(LINKS_FILE, prefs)
      const next = state()
      emit(ctx, 'links.changed', next)
      return next.prefs
    }),
  )
  handle(ctx, 'links.open', async ({ url, reviews }) => {
    const route = resolveLink(loadLinkPrefs(ctx.config), url, (app) => apps.includes(app), {
      reviews,
    })
    if (route.to === 'none' || route.to === 'browser' || route.to === 'reviews')
      return { to: route.to, launched: false }
    return { to: route.to, launched: await launch(route) }
  })
  handle(ctx, 'links.openInArc', async ({ url }) => {
    const href = new URL(url)
    if (href.protocol !== 'http:' && href.protocol !== 'https:') return { launched: false }
    return { launched: await launch({ to: 'app', app: 'Arc', url: href.href }) }
  })
}
