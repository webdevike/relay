import {
  IconArchive,
  IconArchiveOff,
  IconFolderSymlink,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ChatRow as Row } from '@evaos/contract'
import { EvaMenu } from '../../overlay'

export interface RowMenuProps {
  /** The chat the menu is for; null keeps the menu closed. */
  row: Row | null
  /** Viewport point the menu opens at. */
  anchor: { x: number; y: number } | null
  onClose: () => void
  onRename: (row: Row) => void
  onPin: (row: Row) => void
  onArchive: (row: Row) => void
  onDelete: (row: Row) => void
  /**
   * Insertion point between Archive and the divider: 04-16 adds `Move to` here, in the Rust slot,
   * without restructuring the menu.
   */
  menuExtraItems?: ReactNode
}

/** The chat menu in Rust order: Rename, Pin / Unpin, Archive / Unarchive, (extras), divider, Delete. */
export function RowMenu({
  row,
  anchor,
  onClose,
  onRename,
  onPin,
  onArchive,
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
      width={200}
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
              Rename
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
              {row.pinned ? 'Unpin' : 'Pin'}
            </EvaMenu.Item>
            <EvaMenu.Item
              data-testid="row-menu-archive"
              leftSection={
                row.archived ? (
                  <IconArchiveOff size={16} stroke={1.5} />
                ) : (
                  <IconArchive size={16} stroke={1.5} />
                )
              }
              onClick={() => onArchive(row)}
            >
              {row.archived ? 'Unarchive' : 'Archive'}
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
