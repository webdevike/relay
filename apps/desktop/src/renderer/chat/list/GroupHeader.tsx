import { useDraggable, useDroppable } from '@dnd-kit/core'
import { ActionIcon } from '@mantine/core'
import { IconChevronRight, IconDots, IconGripVertical } from '@tabler/icons-react'
import type { KeyboardEvent } from 'react'
import { CategoryInput } from './CategoryInput'

export interface GroupHeaderProps {
  name: string
  total: number
  runningCount: number
  collapsed: boolean
  onToggle: () => void
  /** A user-made category: shows the grip and the header menu. */
  custom?: boolean
  /** A drag is hovering this header: draws the drop indicator. */
  dropTarget?: boolean
  onMenu?: (name: string, x: number, y: number) => void
  /** The name is an inline input. */
  renaming?: boolean
  onRename?: (from: string, to: string) => Promise<string | null>
  onCancelRename?: () => void
}

export function GroupHeader({
  name,
  total,
  runningCount,
  collapsed,
  onToggle,
  custom,
  dropTarget,
  onMenu,
  renaming,
  onRename,
  onCancelRename,
}: GroupHeaderProps) {
  const drag = useDraggable({
    id: `group:${name}`,
    data: { type: 'group', name },
    disabled: renaming,
  })
  const drop = useDroppable({ id: `group:${name}`, data: { type: 'group', name } })

  if (renaming) {
    return (
      <div className="eva-cl-grouprow">
        <CategoryInput
          initial={name}
          onSubmit={(to) => onRename?.(name, to) ?? Promise.resolve(null)}
          onCancel={() => onCancelRename?.()}
        />
      </div>
    )
  }

  const openAtRect = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    onMenu?.(name, r.left, r.bottom)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (custom && ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) {
      e.preventDefault()
      const el = e.currentTarget
      setTimeout(() => openAtRect(el), 0)
    }
  }

  return (
    <div
      ref={(el) => {
        drop.setNodeRef(el)
      }}
      className="eva-cl-grouprow"
      data-drop={dropTarget ? 'true' : undefined}
      data-dragging={drag.isDragging ? 'true' : undefined}
      style={
        drag.transform
          ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)` }
          : undefined
      }
    >
      <button
        ref={drag.setNodeRef}
        {...drag.attributes}
        type="button"
        className="eva-cl-group"
        data-testid={`chat-group-${name}`}
        aria-expanded={!collapsed}
        onClick={onToggle}
        {...drag.listeners}
        onKeyDown={(e) => {
          drag.listeners?.onKeyDown?.(e)
          onKeyDown(e)
        }}
        onContextMenu={(e) => {
          if (!custom || !onMenu) return
          e.preventDefault()
          onMenu(name, e.clientX, e.clientY)
        }}
      >
        {custom ? (
          <IconGripVertical size={14} stroke={1.5} aria-hidden className="eva-cl-grip" />
        ) : null}
        <IconChevronRight
          size={14}
          stroke={1.5}
          aria-hidden
          className="eva-cl-chev"
          style={{ transform: collapsed ? undefined : 'rotate(90deg)' }}
        />
        <span className="eva-cl-group-name">{name}</span>
        <span className="eva-cl-badge">{total}</span>
        {runningCount > 0 ? <span className="eva-cl-running">{runningCount} running</span> : null}
      </button>
      {custom && onMenu ? (
        <ActionIcon
          variant="subtle"
          size={24}
          className="eva-cl-actions"
          data-testid={`group-actions-${name}`}
          aria-label="Category actions"
          aria-haspopup="menu"
          onClick={(e) => openAtRect(e.currentTarget)}
          onKeyDown={onKeyDown}
        >
          <IconDots size={16} stroke={1.5} />
        </ActionIcon>
      ) : null}
    </div>
  )
}
