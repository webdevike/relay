// Meetings on the Relay Host (relay packages/protocol/src/meetings.ts): its recordings, their live
// transcripts and Astra's sessions about them, and the records (work/meetings) for a host that has
// them. `meetings.list` is answered by `meetings.state`; every op is `meetings.req {rid, op}`
// answered by `meetings.res` with the same rid.
import { NO_ANSWER, NOT_CONNECTED, RelayCommandError, type RelayFrames } from './client'

/** `welcome.features` entry of a host that runs Meetings. */
export const MEETINGS_FEATURE = 'meetings'

/** How long an op may take on the host; an Astra ask waits for her session to start. */
const TIMEOUT_MS: Record<string, number> = { ask: 120_000, accept: 30_000 }
export const DEFAULT_TIMEOUT_MS = 20_000

type Frame = Record<string, unknown>

export interface HostMeetings {
  /** `meetings.state` as the host sends it (without `t`). */
  list(): Promise<Frame>
  /** One op; resolves with the answer's fields, rejects with the host's error (and its `code`). */
  req(op: { kind: string } & Record<string, unknown>): Promise<Frame>
}

export function createHostMeetings(
  frames: RelayFrames,
  timeouts: (kind: string) => number = (k) => TIMEOUT_MS[k] ?? DEFAULT_TIMEOUT_MS,
): HostMeetings {
  let seq = 0
  const wait = (match: (f: Frame) => boolean, send: Frame, ms: number): Promise<Frame> => {
    const { promise, resolve, reject } = Promise.withResolvers<Frame>()
    const timer = setTimeout(() => {
      off()
      reject(new RelayCommandError('timeout', NO_ANSWER))
    }, ms)
    const off = frames.onFrame((f) => {
      if (!match(f)) return
      clearTimeout(timer)
      off()
      resolve(f)
    })
    if (!frames.sendFrame(send)) {
      clearTimeout(timer)
      off()
      reject(new RelayCommandError('not_connected', NOT_CONNECTED))
    }
    return promise
  }
  return {
    async list() {
      const { t: _t, ...state } = await wait(
        (f) => f.t === 'meetings.state',
        { t: 'meetings.list' },
        DEFAULT_TIMEOUT_MS,
      )
      return state
    },
    async req(op) {
      seq += 1
      const rid = `relay-desktop-meetings-${Date.now().toString(36)}-${seq}`
      const f = await wait(
        (x) => x.t === 'meetings.res' && x.rid === rid,
        { t: 'meetings.req', rid, op },
        timeouts(op.kind),
      )
      if (f.ok === true) {
        const { t: _t, rid: _rid, ok: _ok, ...answer } = f
        return answer
      }
      const message = typeof f.error === 'string' && f.error !== '' ? f.error : NO_ANSWER
      throw Object.assign(new Error(message), {
        code: typeof f.code === 'string' ? f.code : 'host-refused',
      })
    },
  }
}
