import { useDroppable } from '@dnd-kit/core'
import { Accordion, ActionIcon } from '@mantine/core'
import { IconDots } from '@tabler/icons-react'
import type { KeyboardEvent } from 'react'
import { CategoryInput } from './CategoryInput'
import type { LookStatus } from './look'
import { ProjectBadge } from './ProjectBadge'
import { StatusIcon } from './StatusIcon'

export interface GroupHeaderProps {
  name: string
  count: number
  /**
   * The most urgent status among the folder's chats (native look::hint), shown open or collapsed
   * so a collapsed folder still says that something in it runs.
   */
  hint: LookStatus | null
  /** A user-made category: has the header menu (Rename, Delete). */
  custom?: boolean
  /** A dragged chat is over this header: draws the drop indicator. */
  dropTarget?: boolean
  onMenu?: (name: string, x: number, y: number) => void
  /** The name is an inline input. */
  renaming?: boolean
  onRename?: (from: string, to: string) => Promise<string | null>
  onCancelRename?: () => void
}

/**
 * A workspace folder's header (native look_list): the Accordion.Control of the folder's item, so
 * it carries aria-expanded and aria-controls for its panel. Chevron, badge, name, count, status
 * hint; custom categories add a `...` menu beside the control. Must render inside Accordion.Item.
 */
export function GroupHeader({
  name,
  count,
  hint,
  custom,
  dropTarget,
  onMenu,
  renaming,
  onRename,
  onCancelRename,
}: GroupHeaderProps) {
  const drop = useDroppable({ id: `group:${name}`, data: { type: 'group', name } })

  if (renaming) {
    return (
      <div className="eva-cl-grouprow" data-renaming="true">
        <CategoryInput
          initial={name}
          onSubmit={(to) => onRename?.(name, to) ?? Promise.resolve(null)}
          onCancel={() => onCancelRename?.()}
        />
      </div>
    )
  }

  const menu = custom === true && onMenu !== undefined
  const openAtRect = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    onMenu?.(name, r.left, r.bottom)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (menu && ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) {
      e.preventDefault()
      const el = e.currentTarget
      setTimeout(() => openAtRect(el), 0)
    }
  }

  return (
    <div
      ref={drop.setNodeRef}
      className="eva-cl-grouprow"
      data-drop={dropTarget ? 'true' : undefined}
      data-menu={menu ? 'true' : undefined}
    >
      <Accordion.Control
        className="eva-cl-group"
        data-testid={`chat-group-${name}`}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          if (!menu) return
          e.preventDefault()
          onMenu(name, e.clientX, e.clientY)
        }}
      >
        <ProjectBadge name={name} size="md" />
        <span className="eva-cl-group-name">{name}</span>
        <span className="eva-cl-count">{count}</span>
        <span className="eva-cl-spacer" />
        {hint !== null ? <StatusIcon status={hint} /> : null}
      </Accordion.Control>
      {menu ? (
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
          <IconDots size={14} stroke={1.5} />
        </ActionIcon>
      ) : null}
    </div>
  )
}
