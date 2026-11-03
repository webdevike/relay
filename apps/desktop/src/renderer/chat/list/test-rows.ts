import type { ChatList, ChatRow } from '@evaos/contract'

/** A read, idle Eva chat that returned at `returnedMs` (default 1000); tests override fields. */
export function chatRow(id: string, title: string, extra: Partial<ChatRow> = {}): ChatRow {
  const returnedMs = extra.returnedMs ?? 1000
  return {
    id,
    file: `/s/${id}.jsonl`,
    title,
    mtimeMs: returnedMs,
    archived: false,
    pinned: false,
    running: false,
    status: null,
    agent: 'Eva',
    workedIn: null,
    work: null,
    model: null,
    jobs: 0,
    failed: false,
    returnedMs,
    openedMs: returnedMs,
    keptMs: null,
    snoozedUntilMs: null,
    wokeMs: null,
    startedMs: null,
    owner: null,
    ...extra,
  }
}

export const listPrefs = (extra: Partial<ChatList['prefs']> = {}): ChatList['prefs'] => ({
  chat_categories: [],
  chat_group_order: [],
  chat_assignments: {},
  collapsed_groups: [],
  chat_agent: 'Eva',
  ...extra,
})
