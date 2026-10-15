import { randomUUID } from 'node:crypto'

const TTL_MS = 10 * 60 * 1000
const tokens = new Map<string, { path: string; expires: number }>()

/** Main-issued, single-use handle for a chosen proof photo; the renderer never supplies the path. */
export function issuePhotoToken(path: string, now: number = Date.now()): string {
  for (const [t, v] of tokens) if (v.expires <= now) tokens.delete(t)
  const token = randomUUID()
  tokens.set(token, { path, expires: now + TTL_MS })
  return token
}

/** Resolves and consumes a token; null when unknown, reused or expired. */
export function takePhotoToken(token: string, now: number = Date.now()): string | null {
  const v = tokens.get(token)
  if (!v) return null
  tokens.delete(token)
  return v.expires > now ? v.path : null
}
