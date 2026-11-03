// Approve on an eCard auto-work draft PR: the button shows only while the ticket's ledger
// (work/items/ENG-*.md) is at "9 PR (draft)" with move isaac, and tapping it hands one line to
// Astra's main thread. Astra runs ready.ts; the desktop never does.
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ReviewApprove } from '@evaos/contract'

/** Written by jobs/astra-auto-work when it opens a ledger (ledgerField / Decisions line). */
const AUTO_WORK_MARK = 'auto-work: opened by jobs/astra-auto-work'

const field = (text: string, name: string): string => {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(front)
  return (m?.[1] ?? '').trim()
}

/** What ready.ts approve needs to know about its auto-work watch; the loop starts from the draft state. */
export interface ApproveFacts {
  /** The ticket's self-review loop (auto-work.json `ready`), when one was ever requested. */
  loop: { running: boolean; endedAt: string | null } | null
  /** When Isaac's approve for this ledger state was handed to Astra (epoch ms). */
  sentAt: number | null
}

/** The ENG key of the auto-work ledger whose draft PR is `prUrl` and which waits on Isaac's OK, else null. */
export function approvableKey(
  ledgers: Array<{ key: string; text: string }>,
  prUrl: string,
): string | null {
  for (const { key, text } of ledgers) {
    if (field(text, 'pr') !== prUrl) continue
    if (field(text, 'stage') !== '9 PR (draft)' || field(text, 'move') !== 'isaac') continue
    if (!text.includes(AUTO_WORK_MARK)) continue
    if (!/^ENG-\d+$/.test(key) || field(text, 'key') !== key) continue
    return key
  }
  return null
}

/** ready: tap allowed; sent: handed to Astra, wait for the ledger to move; running: the loop already started. */
export function approveState(f: ApproveFacts): ReviewApprove['state'] {
  if (f.loop?.running) return 'running'
  if (f.sentAt !== null) {
    // A loop that ended after the hand-off (escalated or failed) means Isaac may approve again.
    const ended = f.loop?.endedAt ? Date.parse(f.loop.endedAt) : NaN
    if (Number.isNaN(ended) || ended < f.sentAt) return 'sent'
  }
  return 'ready'
}

/** The line Astra acts on; she runs ready.ts, never the desktop. */
export function approveLine(key: string): string {
  return `Approve request: Isaac approved the auto-work draft PR for ${key} in Relay Reviews. Run \`bun jobs/astra-auto-work/scripts/ready.ts ${key} approve\` from /Users/ike/Eva and report what it printed.`
}

export function readLedgers(evaRoot: string): Array<{ key: string; text: string }> {
  const dir = path.join(evaRoot, 'work/items')
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: Array<{ key: string; text: string }> = []
  for (const n of names) {
    const m = /^(ENG-\d+)\.md$/.exec(n)
    if (!m) continue
    try {
      out.push({ key: m[1]!, text: fs.readFileSync(path.join(dir, n), 'utf8') })
    } catch {
      /* a ledger mid-write: skip it this read */
    }
  }
  return out
}

/** The loop state of `key` from Astra's auto-work.json, or null. */
export function readLoop(evaRoot: string, key: string): ApproveFacts['loop'] {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(evaRoot, 'work/eva/agents/astra/auto-work.json'), 'utf8'),
    ) as { tickets?: Record<string, { ready?: { outcome?: string; endedAt?: string } }> }
    const ready = state.tickets?.[key]?.ready
    if (!ready) return null
    return { running: !ready.outcome, endedAt: ready.endedAt ?? null }
  } catch {
    return null
  }
}
