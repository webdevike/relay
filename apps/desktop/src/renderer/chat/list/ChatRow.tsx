import { ActionIcon, Tooltip } from '@mantine/core'
import { IconDots, IconMessage, IconPlayerPlay } from '@tabler/icons-react'
import { useDraggable } from '@dnd-kit/core'
import { memo, useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import type { ChatRow as Row } from '@evaos/contract'
import { DISMISS_PRIORITY, useDismissable } from '../../hotkeys/dismiss'
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
  /** Opens the chat menu at a viewport point (right-click, `...` button or Shift+F10). */
  onMenu?: (row: Row, x: number, y: number) => void
  /** The title is an inline input; `renamePending` while its commit is in flight. */
  renaming?: boolean
  renamePending?: boolean
  onCommitRename?: (row: Row, name: string) => void
  onCancelRename?: () => void
  /** A failed action's message, shown under the row. */
  error?: string | null
  /** The group the row sits in; undefined for pinned rows. Archived rows pass `noDrag`. */
  group?: string
  noDrag?: boolean
}

function RenameInput({
  row,
  pending,
  onCommit,
  onCancel,
}: {
  row: Row
  pending: boolean
  onCommit: (row: Row, name: string) => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  // Enter and Escape unmount the input, which blurs it: only the first outcome counts.
  const done = useRef(false)
  useEffect(() => {
    // The menu that opened this may hand focus back to its anchor as it closes.
    const focus = (): void => {
      ref.current?.focus()
      ref.current?.select()
    }
    focus()
    const t = setTimeout(focus, 120)
    return () => clearTimeout(t)
  }, [])
  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(row, ref.current?.value ?? '')
    else onCancel()
  }
  // The global Esc ladder runs in the capture phase and would otherwise leave the sub-page.
  useDismissable(DISMISS_PRIORITY.overlay, () => finish(false))
  return (
    <input
      ref={ref}
      className="eva-cl-rename"
      data-testid="chat-rename-input"
      aria-label="Chat name"
      defaultValue={row.title}
      readOnly={pending}
      maxLength={200}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(false)
        }
      }}
      onBlur={() => finish(true)}
    />
  )
}

function ChatRowImpl({
  row,
  active,
  changed,
  onOpen,
  onMenu,
  renaming,
  renamePending,
  onCommitRename,
  onCancelRename,
  error,
  group,
  noDrag,
}: ChatRowProps) {
  const drag = useDraggable({
    id: `chat:${row.id}`,
    data: { type: 'chat', id: row.id, group },
    disabled: noDrag === true || renaming === true,
  })
  const trailing = row.status !== null && row.status !== 'open' ? STATUS_LABEL[row.status] : null
  const errorEl = error ? (
    <div role="alert" className="eva-cl-row-error" data-testid="chat-row-error">
      {error}
    </div>
  ) : null

  if (renaming) {
    return (
      <div className="eva-cl-rowwrap">
        <div className="eva-cl-row" data-testid={`chat-row-${row.id}`} data-renaming="true">
          <StatusIndicator status={row.status} />
          <RenameInput
            row={row}
            pending={renamePending === true}
            onCommit={(r, n) => onCommitRename?.(r, n)}
            onCancel={() => onCancelRename?.()}
          />
        </div>
        {errorEl}
      </div>
    )
  }

  const openAtRect = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    onMenu?.(row, r.left, r.bottom)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') {
      e.preventDefault()
      // Mantine's menu closes on any keydown outside it, including this very event as it bubbles
      // to the document: open on the next task.
      const el = e.currentTarget
      setTimeout(() => openAtRect(el), 0)
    }
  }

  return (
    <div
      className="eva-cl-rowwrap"
      data-dragging={drag.isDragging ? 'true' : undefined}
      style={
        drag.transform
          ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` }
          : undefined
      }
    >
      <Tooltip
        label={row.title}
        openDelay={600}
        position="right"
        withinPortal
        disabled={drag.isDragging}
      >
        <button
          ref={drag.setNodeRef}
          {...drag.attributes}
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
          onContextMenu={(e) => {
            if (!onMenu) return
            e.preventDefault()
            onMenu(row, e.clientX, e.clientY)
          }}
          {...drag.listeners}
          onKeyDown={(e) => {
            drag.listeners?.onKeyDown?.(e)
            onKeyDown(e)
          }}
        >
          <StatusIndicator status={row.status} />
          <span className="eva-cl-title">{row.title}</span>
          {row.archived ? <span className="eva-cl-trailing">Archived</span> : null}
          {trailing ? <span className="eva-cl-trailing">{trailing}</span> : null}
        </button>
      </Tooltip>
      {onMenu ? (
        <ActionIcon
          variant="subtle"
          size={24}
          className="eva-cl-actions"
          data-testid={`chat-actions-${row.id}`}
          aria-label="Chat actions"
          aria-haspopup="menu"
          onClick={(e) => openAtRect(e.currentTarget)}
          onKeyDown={onKeyDown}
        >
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      ) : null}
      {errorEl}
    </div>
  )
}

export const ChatRow = memo(ChatRowImpl)
