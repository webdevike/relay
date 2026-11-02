import { z } from 'zod'

/** The parts of a WHATWG URL the rules read. */
export interface WebUrl {
  readonly href: string
  readonly protocol: string
  readonly host: string
  readonly hostname: string
  readonly pathname: string
  readonly search: string
  readonly hash: string
}
// Both main and the page have the global URL; this package's lib (ES2023 only) doesn't declare it.
declare const URL: new (href: string) => WebUrl

/**
 * Where a clicked web link opens (Settings > Links). Rules are checked in order and the first whose
 * pattern fits wins; no match uses `fallback`. Shape after native EvaOS links.rs, plus custom URL
 * schemes. Shared by main (which launches) and the renderer (which opens the side browser itself).
 */
export const LinkOpenerSchema = z.discriminatedUnion('kind', [
  /** Relay's own browser in the side panel. */
  z.object({ kind: z.literal('browser') }),
  /** macOS's default browser. */
  z.object({ kind: z.literal('system') }),
  /** An installed app by name (`open -a <app>`): `Arc`, `Linear`, `Slack`. */
  z.object({ kind: z.literal('app'), app: z.string().min(1).max(100) }),
  /**
   * A custom URL scheme built from `template`: `{url}` the whole link, `{host}` its host,
   * `{path}` what follows the host (`linear://{path}`).
   */
  z.object({ kind: z.literal('scheme'), template: z.string().min(3).max(300) }),
])
export type LinkOpener = z.infer<typeof LinkOpenerSchema>

export const LinkRuleSchema = z.object({
  /** `example.com` (that host and `www.`), `*.example.com` (its subdomains), optionally `/path` after. */
  pattern: z.string().min(1).max(300),
  opener: LinkOpenerSchema,
})
export type LinkRule = z.infer<typeof LinkRuleSchema>

export const LinkPrefsSchema = z.object({
  rules: z.array(LinkRuleSchema).max(200),
  fallback: LinkOpenerSchema,
})
export type LinkPrefs = z.infer<typeof LinkPrefsSchema>

/** Isaac's defaults: Linear and Slack in their apps, GitHub in Arc, the rest in Relay's browser. */
export const DEFAULT_LINK_PREFS: LinkPrefs = {
  rules: [
    { pattern: 'linear.app', opener: { kind: 'app', app: 'Linear' } },
    { pattern: 'slack.com', opener: { kind: 'app', app: 'Slack' } },
    { pattern: '*.slack.com', opener: { kind: 'app', app: 'Slack' } },
    { pattern: 'github.com', opener: { kind: 'app', app: 'Arc' } },
  ],
  fallback: { kind: 'browser' },
}

/** A typed host or pasted URL as a rule pattern: lowercase host (and path), no scheme, port or query. */
export function normalizePattern(input: string): string | null {
  const text = input.trim().replace(/^https?:\/\//i, '')
  const [authority = '', ...rest] = text.split('/')
  const host = authority.split(/[?#]/)[0]!.split(':')[0]!.toLowerCase()
  const bare = host.startsWith('*.') ? host.slice(2) : host
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare)) return null
  const path = rest.join('/').split(/[?#]/)[0]!.replace(/\/+$/, '')
  return path ? `${host}/${path}` : host
}

/** Whether `url` (a parsed http(s) URL) fits `pattern`. */
export function patternMatches(pattern: string, url: WebUrl): boolean {
  const slash = pattern.indexOf('/')
  const hostPart = (slash < 0 ? pattern : pattern.slice(0, slash)).toLowerCase()
  const pathPart = slash < 0 ? '' : pattern.slice(slash)
  const host = url.hostname.toLowerCase()
  const hostOk = hostPart.startsWith('*.')
    ? host.endsWith(hostPart.slice(1)) && host.length > hostPart.length - 1
    : host === hostPart || host === `www.${hostPart}`
  if (!hostOk) return false
  if (!pathPart) return true
  const path = url.pathname
  return path === pathPart || path.startsWith(pathPart.endsWith('/') ? pathPart : `${pathPart}/`)
}

/** What clicking `href` does: nothing (not a web link), the side browser, or a launch main makes. */
export type LinkRoute =
  | { to: 'none' }
  | { to: 'browser'; url: string }
  | { to: 'system'; url: string }
  | { to: 'app'; app: string; url: string }
  | { to: 'scheme'; url: string }

/** Known desktop apps that take their own scheme rather than the https link (native app_link). */
const APP_LINK: Record<string, (url: WebUrl) => string> = {
  Linear: (u) => `linear://${u.pathname.replace(/^\//, '')}${u.search}${u.hash}`,
  Notion: (u) => `notion://www.notion.so${u.pathname}${u.search}${u.hash}`,
  'Microsoft Teams': (u) => `msteams://${u.host}${u.pathname}${u.search}${u.hash}`,
}

/**
 * Where `href` opens under `prefs`. An app opener for an app that isn't installed (`installed` says
 * no) falls back to the side browser.
 */
export function resolveLink(
  prefs: LinkPrefs,
  href: string,
  installed: (app: string) => boolean,
): LinkRoute {
  let url: WebUrl
  try {
    url = new URL(href)
  } catch {
    return { to: 'none' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { to: 'none' }
  const opener = prefs.rules.find((r) => patternMatches(r.pattern, url))?.opener ?? prefs.fallback
  switch (opener.kind) {
    case 'browser':
      return { to: 'browser', url: url.href }
    case 'system':
      return { to: 'system', url: url.href }
    case 'app':
      if (!installed(opener.app)) return { to: 'browser', url: url.href }
      return { to: 'app', app: opener.app, url: APP_LINK[opener.app]?.(url) ?? url.href }
    case 'scheme': {
      const out = opener.template
        .replaceAll('{url}', url.href)
        .replaceAll('{host}', url.host)
        .replaceAll('{path}', `${url.pathname.replace(/^\//, '')}${url.search}${url.hash}`)
      return /^[a-z][a-z0-9+.-]*:/i.test(out)
        ? { to: 'scheme', url: out }
        : { to: 'browser', url: url.href }
    }
  }
}

export const linksEvents = {
  /** Settings > Links saved new rules. */
  'links.changed': z.object({ prefs: LinkPrefsSchema, apps: z.array(z.string()) }),
} as const

export const linksInvoke = {
  /** The rules (defaults until saved) and the installed apps an app opener can name. */
  'links.get': {
    input: z.object({}).strict(),
    output: z.object({ prefs: LinkPrefsSchema, apps: z.array(z.string()) }),
  },
  'links.set': {
    input: z.object({ prefs: LinkPrefsSchema }).strict(),
    output: LinkPrefsSchema,
  },
  /**
   * Opens `url` outside Relay as the rules say (an app, a scheme, the default browser). Answers
   * where it went; `browser` means the renderer opens it in the side browser itself.
   */
  'links.open': {
    input: z.object({ url: z.string().url().max(8_000) }).strict(),
    output: z.object({
      to: z.enum(['none', 'browser', 'system', 'app', 'scheme']),
      launched: z.boolean(),
    }),
  },
} as const
