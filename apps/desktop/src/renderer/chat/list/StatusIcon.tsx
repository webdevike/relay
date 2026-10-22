import {
  IconAlarm,
  IconAlertCircle,
  IconCircleCheck,
  IconEye,
  IconHandStop,
  IconHelpCircle,
} from '@tabler/icons-react'
import type { LookStatus } from './look'

const ICON = 12

/** Accessible names for the status icons and pills. */
export const STATUS_NAME: Record<LookStatus, string> = {
  working: 'Working',
  approval: 'Needs approval',
  asked: 'Has a question',
  monitoring: 'Monitoring',
  failed: 'Failed',
  woke: 'Woke',
  done: 'Done',
}

export function Spinner() {
  return <span className="eva-cl-spinner" aria-hidden />
}

/**
 * A status icon as the list draws it (native status_icon): a spinner while working, the hand for
 * an approval, the question mark for a question, an eye while monitoring, and so on. Colored by
 * `data-status` in chat-list.css; the working spinner is muted in a folder header.
 */
export function StatusIcon({ status }: { status: LookStatus }) {
  return (
    <span
      className="eva-cl-status"
      data-status={status}
      role="img"
      aria-label={STATUS_NAME[status]}
    >
      {status === 'working' ? <Spinner /> : null}
      {status === 'approval' ? <IconHandStop size={ICON} stroke={1.75} /> : null}
      {status === 'asked' ? <IconHelpCircle size={ICON} stroke={1.75} /> : null}
      {status === 'monitoring' ? <IconEye size={ICON} stroke={1.75} /> : null}
      {status === 'failed' ? <IconAlertCircle size={ICON} stroke={1.75} /> : null}
      {status === 'woke' ? <IconAlarm size={ICON} stroke={1.75} /> : null}
      {status === 'done' ? <IconCircleCheck size={ICON} stroke={1.75} /> : null}
    </span>
  )
}
