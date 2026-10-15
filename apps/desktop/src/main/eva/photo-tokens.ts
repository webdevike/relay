import { randomUUID } from 'node:crypto'

// A break can last up to 600 minutes, so a photo chosen at its start must outlive it.
const TTL_MS = 11 * 60 * 60 * 1000
const tokens = new Map<string, { path: string; expires: number }>()

/** Main-issued, single-use handle for a chosen proof photo; the renderer never supplies the path. */
export function issuePhotoToken(path: string, now: number = Date.now()): string {
  for (const [t, v] of tokens) if (v.expires <= now) tokens.delete(t)
  const token = randomUUID()
  tokens.set(token, { path, expires: now + TTL_MS })
  return token
}

/** Resolves a token without consuming it; null when unknown or expired. */
export function peekPhotoToken(token: string, now: number = Date.now()): string | null {
  const v = tokens.get(token)
  return v && v.expires > now ? v.path : null
}

/** Resolves and consumes a token; null when unknown, reused or expired. */
export function takePhotoToken(token: string, now: number = Date.now()): string | null {
  const v = tokens.get(token)
  if (!v) return null
  tokens.delete(token)
  return v.expires > now ? v.path : null
}
