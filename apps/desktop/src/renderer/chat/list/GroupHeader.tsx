import { IconChevronRight } from '@tabler/icons-react'

export interface GroupHeaderProps {
  name: string
  total: number
  runningCount: number
  collapsed: boolean
  onToggle: () => void
}

export function GroupHeader({ name, total, runningCount, collapsed, onToggle }: GroupHeaderProps) {
  return (
    <button
      type="button"
      className="eva-cl-group"
      data-testid={`chat-group-${name}`}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
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
  )
}
