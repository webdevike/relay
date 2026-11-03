import type { ChatList, ChatRow } from '@evaos/contract'

type ChatStatus = NonNullable<ChatRow['status']>

export type AlertKind = 'needs-approval' | 'has-question' | 'finished'

export interface ChatAlert {
  id: string
  file: string
  kind: AlertKind
  title: string
  body: string
}

const WORDS: Record<AlertKind, string> = {
  'needs-approval': 'Needs your approval',
  'has-question': 'Has a question for you',
  finished: 'Finished',
}

/** Status changes worth a desktop notification: a chat starts waiting on Isaac, or stops working. */
export function chatAlerts(
  prev: ReadonlyMap<string, ChatStatus | null>,
  rows: readonly ChatRow[],
): ChatAlert[] {
  const out: ChatAlert[] = []
  for (const row of rows) {
    // A chat first seen in this list (app launch, new chat) has no transition to report.
    if (!prev.has(row.id) || row.archived) continue
    const was = prev.get(row.id) ?? null
    const now = row.status
    if (now === was) continue
    let kind: AlertKind | null = null
    if (now === 'needs-approval' || now === 'has-question') kind = now
    else if (was === 'working' && now !== 'working') kind = row.failed ? null : 'finished'
    if (kind) out.push({ id: row.id, file: row.file, kind, title: row.title, body: WORDS[kind] })
  }
  return out
}

/** Keeps the last status of every row; each `update` returns the alerts since the previous list. */
export class ChatAlertTracker {
  private last: Map<string, ChatStatus | null> | null = null

  update(list: ChatList): ChatAlert[] {
    const alerts = this.last ? chatAlerts(this.last, list.rows) : []
    // A failed scan returns no rows; keep the old statuses so recovery does not alert.
    if (list.error && list.rows.length === 0) return alerts
    this.last = new Map(list.rows.map((r) => [r.id, r.status]))
    return alerts
  }
}
