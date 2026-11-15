import { DateTime, Effect, Random } from "effect"

/**
 * Ids drawn from the `Random` and `Clock` services instead of `crypto.randomUUID()` / `new Date()`,
 * so `Random.withSeed` and `TestClock` pin them in tests. Ids name events and runs; they are not secrets.
 */

/** 8 hex chars (4 random bytes). */
export const shortId: Effect.Effect<string> = Effect.map(
  Effect.all(Array.from({ length: 4 }, () => Random.nextIntBetween(0, 255))),
  (values) => values.map((value) => value.toString(16).padStart(2, "0")).join("")
)

/** RFC 4122 version 4 UUID: 16 random bytes with the version nibble set to 4 and the variant bits to 10. */
export const uuid: Effect.Effect<string> = Effect.map(Effect.all([shortId, shortId, shortId, shortId]), (parts) => {
  const s = parts.join("")
  const variant = ((Number.parseInt(s[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${variant}${s.slice(17, 20)}-${s.slice(20)}`
})

/** `<UTC yyyymmddThhmmss>-<8 hex>`, e.g. `20261114T204331-af5bf421`: sorts by start time. */
export const runId: Effect.Effect<string> = Effect.gen(function*() {
  const now = yield* DateTime.now
  return `${DateTime.formatIso(now).replace(/[-:]/g, "").slice(0, 15)}-${yield* shortId}`
})
