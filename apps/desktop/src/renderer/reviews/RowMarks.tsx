import type { ReactNode } from 'react'
import {
  IconCircleCheck,
  IconCircleX,
  IconEyeCheck,
  IconLoader2,
  IconMessageExclamation,
  IconPencil,
  IconRefresh,
  IconSend,
  IconThumbUp,
  IconUsers,
} from '@tabler/icons-react'
import { ListMarks, type ListMarkProps, type ListTone } from '../ui/list'
import type { Pill, PillId } from './row-status'

const ICON = { size: 16, stroke: 1.5, 'aria-hidden': true } as const

const TONE: Record<Pill['tone'], ListTone> = {
  green: 'ok',
  red: 'bad',
  amber: 'warn',
  violet: 'accent',
  gray: 'dim',
}

/** Each status's own icon, and the test id its mark keeps. */
const MARK: Record<PillId, { icon: ReactNode; testId?: string }> = {
  draft: { icon: <IconPencil {...ICON} /> },
  'ci-pass': { icon: <IconCircleCheck {...ICON} />, testId: 'review-row-ci' },
  'ci-fail': { icon: <IconCircleX {...ICON} />, testId: 'review-row-ci' },
  'ci-pending': {
    icon: <IconLoader2 {...ICON} className="eva-list-spin" />,
    testId: 'review-row-ci',
  },
  // A draft Astra left for Isaac to approve.
  'approve-ready': { icon: <IconEyeCheck {...ICON} />, testId: 'review-row-approve' },
  'self-review': {
    icon: <IconRefresh {...ICON} className="eva-list-spin" />,
    testId: 'review-row-work',
  },
  approved: { icon: <IconThumbUp {...ICON} />, testId: 'review-row-work' },
  changes: { icon: <IconMessageExclamation {...ICON} />, testId: 'review-row-work' },
  // Out with other reviewers.
  'in-review': { icon: <IconUsers {...ICON} />, testId: 'review-row-work' },
  'ready-for-review': { icon: <IconSend {...ICON} />, testId: 'review-row-work' },
}

/**
 * The slots, left to right, and which statuses fill each: Draft, CI, Approve ready (waiting on
 * Isaac), then where the review stands. The same four on every row, so a status lines up down
 * the page and a row without it leaves its slot empty.
 */
const SLOTS: PillId[][] = [
  ['draft'],
  ['ci-pass', 'ci-fail', 'ci-pending'],
  ['approve-ready'],
  ['self-review', 'approved', 'changes', 'in-review', 'ready-for-review'],
]

/** A PR row's statuses as four fixed icon slots. */
export function RowMarks({ pills }: { pills: readonly Pill[] }) {
  const slots = SLOTS.map((ids): ListMarkProps | null => {
    const p = pills.find((x) => ids.includes(x.id))
    if (!p) return null
    const m = MARK[p.id]
    return { label: p.label, tone: TONE[p.tone], icon: m.icon, 'data-testid': m.testId }
  })
  return <ListMarks slots={slots} data-testid="review-row-status" />
}
