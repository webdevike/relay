import {
  IconArchive,
  IconBell,
  IconBellRinging,
  IconCalendar,
  IconClock,
  IconFolderSymlink,
  IconMoon,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconRestore,
  IconSun,
  IconTrash,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRow as Row } from '@evaos/contract'
import { EvaMenu } from '../../overlay'
import { needsYou, snoozeOptions, type SnoozeLabel } from './look'

export interface RowMenuProps {
  /** The chat the menu is for; null keeps the menu closed. */
  row: Row | null
  /** Archived or fast-settled: offers Unsettle. */
  settled: boolean
  /** Viewport point the menu opens at. */
  anchor: { x: number; y: number } | null
  onClose: () => void
  onRename: (row: Row) => void
  onPin: (row: Row) => void
  /** Snooze until a time, or Unsnooze with null. */
  onSnooze: (row: Row, untilMs: number | null) => void
  onSettle: (row: Row, settled: boolean) => void
  onDelete: (row: Row) => void
  /** Electron's own items (`Move to`), after Settle and before Delete. */
  menuExtraItems?: ReactNode
}

const SNOOZE_ICON: Record<SnoozeLabel, typeof IconClock> = {
  'In 1 hour': IconClock,
  'Next digest': IconBell,
  'Evening digest': IconMoon,
  'Tomorrow morning digest': IconSun,
  Monday: IconCalendar,
}

/**
 * The Snooze presets (native inbox snooze_options) or Unsnooze for a snoozed chat; nothing for a
 * chat waiting on Isaac, which can't be snoozed.
 */
export function SnoozeItems({
  row,
  onSnooze,
}: {
  row: Row
  onSnooze: (row: Row, untilMs: number | null) => void
}) {
  if (row.snoozedUntilMs !== null) {
    return (
      <EvaMenu.Item
        data-testid="row-menu-unsnooze"
        leftSection={<IconBellRinging size={16} stroke={1.5} />}
        onClick={() => onSnooze(row, null)}
      >
        Unsnooze
      </EvaMenu.Item>
    )
  }
  if (needsYou(row)) return null
  return (
    <>
      <EvaMenu.Label>Snooze</EvaMenu.Label>
      {snoozeOptions(new Date()).map((o) => {
        const Icon = SNOOZE_ICON[o.label]
        return (
          <EvaMenu.Item
            key={o.label}
            data-testid={`row-menu-snooze-${o.label}`}
            leftSection={<Icon size={16} stroke={1.5} />}
            rightSection={<span className="eva-cl-menu-when">{o.when}</span>}
            onClick={() => onSnooze(row, o.untilMs)}
          >
            {o.label}
          </EvaMenu.Item>
        )
      })}
    </>
  )
}

/**
 * The chat menu in native order (chat_menu): Rename chat, Pin / Unpin chat, the Snooze section,
 * Settle / Unsettle, then Electron's Move to, divider, Delete.
 */
export function RowMenu({
  row,
  settled,
  anchor,
  onClose,
  onRename,
  onPin,
  onSnooze,
  onSettle,
  onDelete,
  menuExtraItems,
}: RowMenuProps) {
  // Portalled to the body: the sidebar is a containing block for fixed children, which would
  // shift the zero-size anchor (and the menu with it) away from the pointer.
  return createPortal(
    <EvaMenu
      opened={row !== null && anchor !== null}
      onChange={(o) => {
        if (!o) onClose()
      }}
      width={260}
      position="bottom-start"
      offset={0}
    >
      <EvaMenu.Target>
        <span
          className="eva-cl-menu-anchor"
          style={{ left: anchor?.x ?? 0, top: anchor?.y ?? 0 }}
          aria-hidden
        />
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="row-menu">
        {row ? (
          <>
            <EvaMenu.Item
              data-testid="row-menu-rename"
              leftSection={<IconPencil size={16} stroke={1.5} />}
              onClick={() => onRename(row)}
            >
              Rename chat
            </EvaMenu.Item>
            <EvaMenu.Item
              data-testid="row-menu-pin"
              leftSection={
                row.pinned ? (
                  <IconPinnedOff size={16} stroke={1.5} />
                ) : (
                  <IconPin size={16} stroke={1.5} />
                )
              }
              onClick={() => onPin(row)}
            >
              {row.pinned ? 'Unpin chat' : 'Pin chat'}
            </EvaMenu.Item>
            {row.snoozedUntilMs !== null || !needsYou(row) ? (
              <>
                <EvaMenu.Divider />
                <SnoozeItems row={row} onSnooze={onSnooze} />
              </>
            ) : null}
            <EvaMenu.Divider />
            <EvaMenu.Item
              data-testid="row-menu-settle"
              leftSection={
                settled ? (
                  <IconRestore size={16} stroke={1.5} />
                ) : (
                  <IconArchive size={16} stroke={1.5} />
                )
              }
              onClick={() => onSettle(row, !settled)}
            >
              {settled ? 'Unsettle' : 'Settle'}
            </EvaMenu.Item>
            {menuExtraItems}
            <EvaMenu.Divider />
            <EvaMenu.Item
              data-testid="row-menu-delete"
              className="eva-cl-menu-danger"
              leftSection={<IconTrash size={16} stroke={1.5} />}
              onClick={() => onDelete(row)}
            >
              Delete
            </EvaMenu.Item>
          </>
        ) : null}
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}

export interface MoveToProps {
  row: Row
  /** Every category name offered, in list order. */
  groups: readonly string[]
  onMove: (row: Row, group: string) => void
  onNewCategory: (row: Row) => void
}

/** `Move to` submenu for the menuExtraItems slot: every category, then `New category`. */
export function MoveToItem({ row, groups, onMove, onNewCategory }: MoveToProps) {
  return (
    <EvaMenu.Sub>
      <EvaMenu.Sub.Target>
        <EvaMenu.Sub.Item
          data-testid="row-menu-move"
          leftSection={<IconFolderSymlink size={16} stroke={1.5} />}
        >
          Move to
        </EvaMenu.Sub.Item>
      </EvaMenu.Sub.Target>
      <EvaMenu.Sub.Dropdown data-testid="row-menu-move-list">
        {groups.map((g) => (
          <EvaMenu.Item key={g} data-testid={`row-menu-move-${g}`} onClick={() => onMove(row, g)}>
            {g}
          </EvaMenu.Item>
        ))}
        <EvaMenu.Divider />
        <EvaMenu.Item
          data-testid="row-menu-move-new"
          leftSection={<IconPlus size={16} stroke={1.5} />}
          onClick={() => onNewCategory(row)}
        >
          New category
        </EvaMenu.Item>
      </EvaMenu.Sub.Dropdown>
    </EvaMenu.Sub>
  )
}
