// Reviews in remote mode: gh, the Linear key, Slack, the auto-work ledgers and Astra all live on the
// Mini, so every Reviews read and write is a `reviews.req {rid, op}` to the Mini's Relay Host,
// answered by `reviews.res` with the same rid (relay packages/protocol/src/reviews.ts). The host
// also pushes `reviews.queue` and `reviews.astra` to every device.
import { NO_ANSWER, NOT_CONNECTED, RelayCommandError, type RelayFrames } from './client'

/** What an old host (one that does not know the op) leaves us with: nothing comes back. */
export const OLD_HOST = 'The Mini’s Relay Host didn’t answer. If this keeps happening, update it.'

/** How long an op may take on the host before it counts as unanswered. */
const TIMEOUT_MS: Record<string, number> = {
  queue: 90_000,
  pr: 90_000,
  // A model writes the Guide the first time per head commit.
  guide: 240_000,
  linear: 60_000,
  // A fresh thread read runs headless claude: minutes.
  slack: 300_000,
  astraAsk: 120_000,
  prList: 30_000,
  prView: 60_000,
}
export const DEFAULT_TIMEOUT_MS = 20_000

export type HostOp = { kind: string } & Record<string, unknown>
export type HostAnswer = Record<string, unknown>
type Frame = Record<string, unknown>

export interface HostReviews {
  /** One op; resolves with the answer's fields, rejects with the host's one-line error, NOT_CONNECTED or OLD_HOST. */
  req(op: HostOp): Promise<HostAnswer>
  /** Every `reviews.queue` and `reviews.astra` push (the frame as heard). */
  onPush(cb: (frame: Frame) => void): () => void
}

export function createHostReviews(
  frames: RelayFrames,
  timeouts: (kind: string) => number = (kind) => TIMEOUT_MS[kind] ?? DEFAULT_TIMEOUT_MS,
): HostReviews {
  let seq = 0
  return {
    req(op) {
      seq += 1
      const rid = `relay-desktop-reviews-${Date.now().toString(36)}-${seq}`
      const { promise, resolve, reject } = Promise.withResolvers<HostAnswer>()
      const timer = setTimeout(() => {
        off()
        reject(new RelayCommandError('timeout', OLD_HOST))
      }, timeouts(op.kind))
      const off = frames.onFrame((f) => {
        if (f.t !== 'reviews.res' || f.rid !== rid) return
        clearTimeout(timer)
        off()
        if (f.ok === true) {
          const { t: _t, rid: _rid, ok: _ok, ...answer } = f
          resolve(answer)
        } else {
          const msg = typeof f.error === 'string' && f.error !== '' ? f.error : NO_ANSWER
          reject(new RelayCommandError('internal', msg))
        }
      })
      if (!frames.sendFrame({ t: 'reviews.req', rid, op })) {
        clearTimeout(timer)
        off()
        reject(new RelayCommandError('not_connected', NOT_CONNECTED))
      }
      return promise
    },
    onPush(cb) {
      return frames.onFrame((f) => {
        if (f.t === 'reviews.queue' || f.t === 'reviews.astra') cb(f)
      })
    },
  }
}
