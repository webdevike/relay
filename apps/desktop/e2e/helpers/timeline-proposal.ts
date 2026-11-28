// Astra's re-plan answer (`e2e/fixtures/tickets/replan-proposal.json`) as a Relay host sends it:
// with the account it read the board as and each changed ticket's baseline (stable issue id,
// `updatedAt`, due date, priority, order, Relay start). The Timeline drops a proposal without them.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'

type Json = Record<string, unknown>

/**
 * The host's proposal over `tickets` (the fake host's board) for `viewerId` (its
 * `tickets.status` identity); `starts` adds a Relay start to a change by key (a mixed row).
 */
export function hostProposal(
  tickets: readonly Json[],
  viewerId: string,
  starts: Readonly<Record<string, string>> = {},
): Json {
  const file = path.join(__dirname, '..', 'fixtures', 'tickets', 'replan-proposal.json')
  const answer = JSON.parse(fs.readFileSync(file, 'utf8')) as { changes: { key: string }[] }
  const changes = answer.changes.map((c) =>
    starts[c.key] === undefined ? c : { ...c, start: starts[c.key] },
  )
  const baseline = tickets
    .filter((t) => changes.some((c) => c.key === t['key']))
    .map((t) => ({
      key: t['key'],
      issueId: t['id'],
      updatedAt: t['updatedAt'],
      dueDate: t['dueDate'],
      priority: t['priority'],
      prioritySortOrder: t['prioritySortOrder'],
      plannedStart: t['plannedStart'] ?? null,
    }))
  return { ...answer, changes, viewerId, baseline }
}

const HostIdentity = z.object({
  identity: z.object({ linear: z.object({ viewerId: z.string() }) }),
})

/** The Linear account a fake host's `tickets.status` names. */
export function hostViewerId(status: unknown): string {
  return HostIdentity.parse(status).identity.linear.viewerId
}
