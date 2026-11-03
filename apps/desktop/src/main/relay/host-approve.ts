// Approve in remote mode: the auto-work ledgers, auto-work.json and Astra's thread live on the Mini,
// not on this laptop, so Reviews asks the Mini's Relay Host (`reviews.req` ops `approvable` and
// `approve`, answered by `reviews.res` with the same rid).
import { ReviewWorkSchema, type ReviewApprove, type ReviewWork } from '@evaos/contract'
import { NO_ANSWER, NOT_CONNECTED, RelayCommandError, type RelayFrames } from './client'

export const HOST_APPROVE_TIMEOUT_MS = 20_000
/** What an old host (one that does not know the op) leaves us with: nothing comes back. */
export const OLD_HOST = 'The Mini’s Relay Host is too old to answer Approve. Update it.'

export interface HostApprove {
  /** The auto-work state of `repo#number` on the Mini; null when it is not waiting on Isaac. */
  approvable(repo: string, number: number): Promise<ReviewApprove | null>
  /** Hands the approve to Astra from the Mini; resolves with the state it now reads. */
  approve(repo: string, number: number): Promise<ReviewApprove | null>
  /** The auto-work ledger and self-review loop behind `repo#number` on the Mini; null when auto-work did not open it. */
  work(repo: string, number: number): Promise<ReviewWork | null>
}

interface Answer {
  approve: ReviewApprove | null
  work: ReviewWork | null
}
const isApprove = (v: unknown): v is ReviewApprove => {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Record<string, unknown>
  return typeof a.key === 'string' && ['ready', 'sent', 'running'].includes(a.state as string)
}

export function createHostApprove(
  frames: RelayFrames,
  timeoutMs = HOST_APPROVE_TIMEOUT_MS,
): HostApprove {
  let seq = 0
  const req = (op: Record<string, unknown>): Promise<Answer> => {
    seq += 1
    const rid = `relay-desktop-approve-${Date.now().toString(36)}-${seq}`
    const { promise, resolve, reject } = Promise.withResolvers<Answer>()
    const timer = setTimeout(() => {
      off()
      reject(new RelayCommandError('timeout', OLD_HOST))
    }, timeoutMs)
    const off = frames.onFrame((f) => {
      if (f.t !== 'reviews.res' || f.rid !== rid) return
      clearTimeout(timer)
      off()
      if (f.ok === true) {
        resolve({
          approve: isApprove(f.approve) ? f.approve : null,
          work: ReviewWorkSchema.safeParse(f.work).data ?? null,
        })
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
  }
  return {
    approvable: (repo, number) => req({ kind: 'approvable', repo, number }).then((r) => r.approve),
    approve: (repo, number) => req({ kind: 'approve', repo, number }).then((r) => r.approve),
    work: (repo, number) => req({ kind: 'work', repo, number }).then((r) => r.work),
  }
}
