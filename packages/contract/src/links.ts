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
  /**
   * Relay's Reviews page, for a link to an item it shows (a GitHub pull request, a Linear issue, a
   * Slack message); any other link the rule fits goes on to the next rule.
   */
  z.object({ kind: z.literal('reviews') }),
])
export type LinkOpener = z.infer<typeof LinkOpenerSchema>

export const LinkRuleSchema = z.object({
  /**
   * `example.com` (that host and `www.`), `*.example.com` (its subdomains), optionally `/path` after,
   * where a `*` path segment fits any one segment (`github.com/<any>/<any>/pull`).
   */
  pattern: z.string().min(1).max(300),
  opener: LinkOpenerSchema,
})
export type LinkRule = z.infer<typeof LinkRuleSchema>

export const LinkPrefsSchema = z.object({
  rules: z.array(LinkRuleSchema).max(200),
  fallback: LinkOpenerSchema,
  /** Default rule sets added since the file was written (`reviews`), so each is added once. */
  seeded: z.array(z.string().max(40)).max(20).optional(),
})
export type LinkPrefs = z.infer<typeof LinkPrefsSchema>

/** Pull requests, Linear issues and Slack messages open in Relay Reviews. */
export const REVIEW_LINK_RULES: LinkRule[] = [
  { pattern: 'github.com/*/*/pull', opener: { kind: 'reviews' } },
  { pattern: 'linear.app/*/issue', opener: { kind: 'reviews' } },
  { pattern: '*.slack.com/archives', opener: { kind: 'reviews' } },
]

/**
 * Isaac's defaults: pull requests, Linear issues and Slack messages in Reviews, the rest of Linear
 * and Slack in their apps, GitHub in Arc, everything else in Relay's browser.
 */
export const DEFAULT_LINK_PREFS: LinkPrefs = {
  rules: [
    ...REVIEW_LINK_RULES,
    { pattern: 'linear.app', opener: { kind: 'app', app: 'Linear' } },
    { pattern: 'slack.com', opener: { kind: 'app', app: 'Slack' } },
    { pattern: '*.slack.com', opener: { kind: 'app', app: 'Slack' } },
    { pattern: 'github.com', opener: { kind: 'app', app: 'Arc' } },
  ],
  fallback: { kind: 'browser' },
  seeded: ['reviews'],
}

/**
 * Saved prefs from before the Reviews rules: adds them once, above the first rule for
 * linear.app, slack.com or github.com (else first). Answers `prefs` itself when nothing changes.
 */
export function seedLinkPrefs(prefs: LinkPrefs): LinkPrefs {
  if (prefs.seeded?.includes('reviews')) return prefs
  const missing = REVIEW_LINK_RULES.filter((d) => !prefs.rules.some((r) => r.pattern === d.pattern))
  const at = prefs.rules.findIndex((r) =>
    /^(\*\.)?(linear\.app|slack\.com|github\.com)(\/|$)/.test(r.pattern),
  )
  const i = at < 0 ? 0 : at
  return {
    ...prefs,
    rules: [...prefs.rules.slice(0, i), ...missing, ...prefs.rules.slice(i)].slice(0, 200),
    seeded: [...(prefs.seeded ?? []), 'reviews'],
  }
}

/** Whether `url` names an item Relay Reviews shows: a pull request, a Linear issue, a Slack message. */
export function isReviewItemUrl(url: WebUrl): boolean {
  const host = url.hostname.toLowerCase()
  if (host === 'github.com' || host === 'www.github.com')
    return /^\/[^/]+\/[^/]+\/pull\/\d+(\/|$)/.test(url.pathname)
  if (host === 'linear.app') return /^\/[^/]+\/issue\/[a-z][a-z0-9]*-\d+(\/|$)/i.test(url.pathname)
  if (host.endsWith('.slack.com')) return /^\/archives\/[A-Z0-9]+\/p\d{7,}$/.test(url.pathname)
  return false
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
  // Segment by segment: `*` fits any one segment; the URL may go on past the pattern.
  const want = pathPart.split('/').filter(Boolean)
  const have = url.pathname.split('/').filter(Boolean)
  return want.length <= have.length && want.every((w, i) => w === '*' || w === have[i])
}

/** What clicking `href` does: nothing (not a web link), the side browser, or a launch main makes. */
export type LinkRoute =
  | { to: 'none' }
  | { to: 'browser'; url: string }
  | { to: 'system'; url: string }
  | { to: 'app'; app: string; url: string }
  | { to: 'scheme'; url: string }
  /** Relay's Reviews page opens the item (the renderer does it; main never launches it). */
  | { to: 'reviews'; url: string }

/** Known desktop apps that take their own scheme rather than the https link (native app_link). */
const APP_LINK: Record<string, (url: WebUrl) => string> = {
  Linear: (u) => `linear://${u.pathname.replace(/^\//, '')}${u.search}${u.hash}`,
  Notion: (u) => `notion://www.notion.so${u.pathname}${u.search}${u.hash}`,
  'Microsoft Teams': (u) => `msteams://${u.host}${u.pathname}${u.search}${u.hash}`,
}

/**
 * Where `href` opens under `prefs`. An app opener for an app that isn't installed (`installed` says
 * no) falls back to the side browser. A Reviews rule fits only an item link (`isReviewItemUrl`),
 * and none does with `reviews: false` (Reviews' own "Open in Linear" buttons).
 */
export function resolveLink(
  prefs: LinkPrefs,
  href: string,
  installed: (app: string) => boolean,
  opts: { reviews?: boolean | undefined } = {},
): LinkRoute {
  let url: WebUrl
  try {
    url = new URL(href)
  } catch {
    return { to: 'none' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { to: 'none' }
  const reviews = opts.reviews !== false && isReviewItemUrl(url)
  const fits = (o: LinkOpener): boolean => o.kind !== 'reviews' || reviews
  const rule = prefs.rules.find((r) => fits(r.opener) && patternMatches(r.pattern, url))
  const opener = rule?.opener ?? prefs.fallback
  switch (opener.kind) {
    case 'reviews':
      return reviews ? { to: 'reviews', url: url.href } : { to: 'browser', url: url.href }
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
   * where it went; `browser` and `reviews` mean the renderer opens it itself. `reviews: false`
   * skips the Reviews rules (Reviews' own buttons that leave Relay).
   */
  'links.open': {
    input: z.object({ url: z.string().url().max(8_000), reviews: z.boolean().optional() }).strict(),
    output: z.object({
      to: z.enum(['none', 'browser', 'system', 'app', 'scheme', 'reviews']),
      launched: z.boolean(),
    }),
  },
  /** Option+click on a web link: opens it in Arc (`open -a Arc <url>`), http(s) only. */
  'links.openInArc': {
    input: z
      .object({
        url: z
          .string()
          .url()
          .max(8_000)
          .refine((u) => /^https?:\/\//i.test(u), { message: 'an http(s) URL' }),
      })
      .strict(),
    output: z.object({ launched: z.boolean() }),
  },
} as const
