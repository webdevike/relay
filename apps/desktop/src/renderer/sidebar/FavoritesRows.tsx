import { useDraggable, useDroppable } from '@dnd-kit/core'
import { IconChevronDown, IconChevronRight, IconFolder, IconFolderOpen } from '@tabler/icons-react'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from 'react'
import { ListRow, type ActivateEvent } from '../ui/list'
import { navIcon } from './icons'
import { sidebarPrefsStore, type FavFolder, type FavItem, type FavNode } from './sidebar-prefs'

/** One drawn favorite: a folder, a favorite at the top level, or one inside an open folder. */
export interface FavEntry {
  node: FavNode
  nested: boolean
}

/** The favorites as rows: each folder followed by its favorites while it is open. */
export function favEntries(nodes: readonly FavNode[]): FavEntry[] {
  return nodes.flatMap((node): FavEntry[] =>
    node.kind === 'folder'
      ? [
          { node, nested: false },
          ...(node.open ? node.items.map((i): FavEntry => ({ node: i, nested: true })) : []),
        ]
      : [{ node, nested: false }],
  )
}

const stop = (e: SyntheticEvent): void => e.stopPropagation()

function RenameInput({ folder, onDone }: { folder: FavFolder; onDone: () => void }) {
  const [value, setValue] = useState(folder.name)
  const input = useRef<HTMLInputElement>(null)
  // Naming a folder is the point of creating or renaming one.
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const commit = (): void => {
    const name = value.trim()
    if (name !== '' && name !== folder.name)
      sidebarPrefsStore.getState().renameFolder(folder.id, name)
    onDone()
  }
  return (
    <input
      className="eva-sb-fav-rename"
      data-testid="fav-rename"
      aria-label="Folder name"
      ref={input}
      value={value}
      maxLength={120}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') onDone()
      }}
    />
  )
}

export function FavRow({
  entry,
  title,
  active,
  renaming,
  onOpen,
  onMenu,
  onRenameDone,
}: {
  entry: FavEntry
  /** A chat favorite's title now, which may differ from the one saved. */
  title: string
  active: boolean
  renaming: boolean
  onOpen: (item: FavItem, e: ActivateEvent) => void
  onMenu: (node: FavNode, x: number, y: number) => void
  onRenameDone: () => void
}) {
  const { node } = entry
  const drag = useDraggable({ id: node.id })
  const drop = useDroppable({ id: node.id })
  const t = drag.transform
  // dnd-kit types its listeners as bare Functions; the pointer sensor's is a pointer handler.
  const onPointerDown = drag.listeners?.['onPointerDown'] as
    ((e: PointerEvent<HTMLDivElement>) => void) | undefined
  const folder = node.kind === 'folder'
  const Glyph = node.kind === 'item' ? navIcon(node.icon) : node.open ? IconFolderOpen : IconFolder
  const Caret = folder && node.open ? IconChevronDown : IconChevronRight
  return (
    <ListRow
      ref={(el) => {
        drag.setNodeRef(el)
        drop.setNodeRef(el)
      }}
      className={`eva-sb-fav${entry.nested ? ' eva-sb-fav-nested' : ''}`}
      data-testid={folder ? 'fav-folder' : 'fav-item'}
      data-title={title}
      data-dragging={drag.isDragging ? 'true' : undefined}
      data-over={drop.isOver && !drag.isDragging ? (folder ? 'into' : 'before') : undefined}
      style={t ? { transform: `translate3d(${t.x}px, ${t.y}px, 0)` } : undefined}
      active={active}
      leading={<Glyph size={16} aria-hidden />}
      title={renaming && folder ? <RenameInput folder={node} onDone={onRenameDone} /> : title}
      trailing={
        folder ? <Caret size={14} stroke={1.5} aria-hidden className="eva-sb-chev" /> : undefined
      }
      onActivate={(e) => {
        if (node.kind === 'folder') sidebarPrefsStore.getState().toggleFolder(node.id)
        else onOpen(node, e)
      }}
      middleClick={!folder}
      onMenu={(x, y) => onMenu(node, x, y)}
      {...drag.attributes}
      onPointerDown={onPointerDown}
    />
  )
}
