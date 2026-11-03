import { execFile } from 'node:child_process'
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

export type Launcher = (
  route: Exclude<LinkRoute, { to: 'none' } | { to: 'browser' } | { to: 'reviews' }>,
) => Promise<boolean>

/** Launches outside Relay: `open -a <app> <url>`, else the system's handler for the URL. */
export const launchRoute: Launcher = (route) => {
  if (route.to === 'app') {
    return new Promise((resolve) => {
      execFile('/usr/bin/open', ['-a', route.app, route.url], (err) => resolve(!err))
    })
  }
  return shell.openExternal(route.url).then(
    () => true,
    () => false,
  )
}

export function registerLinksIpc(
  ctx: MainContext,
  queue: WriteQueue,
  opts: { dirs?: string[]; launch?: Launcher } = {},
): void {
  const dirs = opts.dirs ?? appDirs()
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
      : launchRoute)
  let apps = installedApps(dirs)
  const state = (): { prefs: LinkPrefs; apps: string[] } => ({
    prefs: loadLinkPrefs(ctx.config),
    apps,
  })
  handle(ctx, 'links.get', () => {
    apps = installedApps(dirs)
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
}
