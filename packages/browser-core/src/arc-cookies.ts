import { z } from 'zod'

/** Playwright cookie as printed by Eva's Arc exporter (`.omp/tools/arc-cookies.ts`). */
export const ArcCookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  url: z.string().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.string().optional(),
})
export type ArcCookie = z.output<typeof ArcCookieSchema>

export interface ElectronCookie {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: 'lax' | 'strict' | 'no_restriction' | 'unspecified'
}

function sameSite(v: string | undefined): ElectronCookie['sameSite'] {
  switch (v) {
    case 'Lax':
      return 'lax'
    case 'Strict':
      return 'strict'
    case 'None':
      return 'no_restriction'
    default:
      return 'unspecified'
  }
}

/**
 * Mirrors Rust `arc_cookie`: host-only cookies carry `url` and keep no `domain` (so `__Host-`
 * cookies are accepted); the rest carry `domain` + `path`. `expires` <= 0 is a session cookie.
 */
export function toElectronCookie(c: ArcCookie): ElectronCookie | null {
  let url: string
  let domain: string | undefined
  let path = '/'
  if (c.url) {
    // No URL global in this package (no DOM or node types): split scheme and host by hand.
    const m = /^(https?):\/\/([^/?#]+)/.exec(c.url)
    if (!m) return null
    url = `${m[1]}://${m[2]}/`
  } else if (c.domain) {
    domain = c.domain
    path = c.path ?? '/'
    url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${path}`
  } else {
    return null
  }
  const out: ElectronCookie = {
    url,
    name: c.name,
    value: c.value,
    path,
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite: sameSite(c.sameSite),
  }
  if (domain !== undefined) out.domain = domain
  if (c.expires !== undefined && c.expires > 0) out.expirationDate = c.expires
  return out
}

/** Parses exporter stdout. Invalid entries are dropped; non-array JSON throws. */
export function parseArcExport(stdout: string): ElectronCookie[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    throw new Error('The Arc export was not JSON')
  }
  if (!Array.isArray(json)) throw new Error('The Arc export was not JSON')
  const out: ElectronCookie[] = []
  for (const item of json) {
    const p = ArcCookieSchema.safeParse(item)
    if (!p.success) continue
    const c = toElectronCookie(p.data)
    if (c) out.push(c)
  }
  return out
}
