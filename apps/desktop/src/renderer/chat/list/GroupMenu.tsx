import { IconPencil, IconTrash } from '@tabler/icons-react'
import { createPortal } from 'react-dom'
import { EvaMenu } from '../../overlay'

export interface GroupMenuProps {
  /** The custom category the menu is for; null keeps it closed. */
  name: string | null
  anchor: { x: number; y: number } | null
  onClose: () => void
  onRename: (name: string) => void
  onDelete: (name: string) => void
}

/** Header menu of a custom category. Workspace headers have no menu. */
export function GroupMenu({ name, anchor, onClose, onRename, onDelete }: GroupMenuProps) {
  return createPortal(
    <EvaMenu
      opened={name !== null && anchor !== null}
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
      <EvaMenu.Dropdown data-testid="group-menu">
        {name !== null ? (
          <>
            <EvaMenu.Item
              data-testid="group-menu-rename"
              leftSection={<IconPencil size={16} stroke={1.5} />}
              onClick={() => onRename(name)}
            >
              Rename category
            </EvaMenu.Item>
            <EvaMenu.Item
              data-testid="group-menu-delete"
              className="eva-cl-menu-danger"
              leftSection={<IconTrash size={16} stroke={1.5} />}
              onClick={() => onDelete(name)}
            >
              Delete category
            </EvaMenu.Item>
          </>
        ) : null}
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}
