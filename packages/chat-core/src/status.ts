/** One module for chat status wording (Rust words, sentence-cased). Flip a label here to change it everywhere. */
export const CHAT_STATUSES = ['open', 'working', 'needs-approval', 'has-question', 'job'] as const
export type ChatStatus = (typeof CHAT_STATUSES)[number]

export const STATUS_LABEL: Record<ChatStatus, string> = {
  open: 'Open',
  working: 'Working',
  'needs-approval': 'Needs approval',
  'has-question': 'Has a question',
  job: 'Job',
}

/** Precedence follows Rust: a waiting dialog first, then working, then background jobs, then merely open. */
export function rowStatus(i: {
  owned: boolean
  working: boolean
  dialog: 'confirm' | 'other' | null
  jobs: number
}): ChatStatus | null {
  if (i.dialog === 'confirm') return 'needs-approval'
  if (i.dialog === 'other') return 'has-question'
  if (i.working) return 'working'
  if (i.jobs > 0) return 'job'
  if (i.owned) return 'open'
  return null
}
