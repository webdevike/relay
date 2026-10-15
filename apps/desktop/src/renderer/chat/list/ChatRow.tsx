import { Tooltip } from '@mantine/core'
import { IconMessage, IconPlayerPlay } from '@tabler/icons-react'
import { memo, type MouseEvent } from 'react'
import type { ChatRow as Row } from '@evaos/contract'
import { STATUS_LABEL, type ChatStatus } from '@evaos/chat-core/status'

export function StatusIndicator({ status }: { status: ChatStatus | null }) {
  if (status === null) {
    return (
      <span className="eva-cl-status" aria-hidden>
        <IconMessage size={16} stroke={1.5} />
      </span>
    )
  }
  const label = STATUS_LABEL[status]
  return (
    <span className="eva-cl-status" role="img" aria-label={label} data-status={status}>
      {status === 'job' ? (
        <IconPlayerPlay size={16} stroke={1.5} aria-hidden />
      ) : (
        <span className="eva-cl-dot" data-status={status} />
      )}
    </span>
  )
}

export interface ChatRowProps {
  row: Row
  active: boolean
  /** Fades the background for 300 ms after a title, status or mtime change. */
  changed?: boolean
  onOpen: (row: Row, e: MouseEvent) => void
}

function ChatRowImpl({ row, active, changed, onOpen }: ChatRowProps) {
  const trailing = row.status !== null && row.status !== 'open' ? STATUS_LABEL[row.status] : null
  return (
    <Tooltip label={row.title} openDelay={600} position="right" withinPortal>
      <button
        type="button"
        role="treeitem"
        aria-selected={active}
        className="eva-cl-row"
        data-testid={`chat-row-${row.id}`}
        data-active={active ? 'true' : undefined}
        data-changed={changed ? 'true' : undefined}
        aria-label={`${row.title}${row.status !== null ? `, ${STATUS_LABEL[row.status]}` : ''}`}
        data-running={row.running ? 'true' : undefined}
        onClick={(e) => onOpen(row, e)}
      >
        <StatusIndicator status={row.status} />
        <span className="eva-cl-title">{row.title}</span>
        {row.archived ? <span className="eva-cl-trailing">Archived</span> : null}
        {trailing ? <span className="eva-cl-trailing">{trailing}</span> : null}
      </button>
    </Tooltip>
  )
}

export const ChatRow = memo(ChatRowImpl)
