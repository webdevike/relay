import './chat-list.css'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { ActionIcon } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { ChatRow as Row } from '@evaos/contract'
import { Categories } from '@evaos/chat-core/categories'
import { groupChats } from '@evaos/chat-core/chat-groups'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../../navigation/navigate'
import { activePlace, useTabs } from '../../tabs/tabs-store'
import { ChatRow } from './ChatRow'
import { DeleteChatModal } from './DeleteChatModal'
import { MoveToItem, RowMenu } from './RowMenu'
import { CategoryInput } from './CategoryInput'
import { DeleteCategoryModal } from './DeleteCategoryModal'
import { ACTIVATION_DISTANCE, resolveDrop, type DragData } from './dnd'
import { GroupMenu } from './GroupMenu'
import { GroupHeader } from './GroupHeader'
import { registerReloader } from '../../reload/reload'
import { listStore, subscribeListChanges, useListStore } from './list-store'

const EMPTY_HEADING = 'No chats yet'
const EMPTY_BODY = 'Start a new chat to talk with Eva. Your omp sessions appear here.'

const DEBOUNCE_MS = 100

const { openMenu, closeMenu, startRename, cancelRename, commitRename, setDeleting, pin, archive } =
  listStore.getState()

const onMenu = (r: Row, x: number, y: number): void => openMenu(r.id, x, y)

const collision: CollisionDetection = (args) =>
  args.pointerCoordinates && args.active.data.current?.type === 'chat'
    ? pointerWithin(args)
    : closestCenter(args)

const announcements = {
  onDragStart: ({ active }: { active: { data: { current?: unknown } } }): string => {
    const d = active.data.current as DragData | undefined
    return d?.type === 'group' ? `Picked up the ${d.name} group.` : 'Picked up a chat.'
  },
  onDragOver: ({ over }: { over: { data: { current?: unknown } } | null }): string => {
    const d = over?.data.current as DragData | undefined
    return d?.type === 'group' ? `Over the ${d.name} group.` : 'Not over a group.'
  },
  onDragEnd: ({ over }: { over: { data: { current?: unknown } } | null }): string => {
    const d = over?.data.current as DragData | undefined
    return d?.type === 'group' ? `Dropped on the ${d.name} group.` : 'Dropped. Nothing changed.'
  },
  onDragCancel: (): string => 'Move cancelled.',
}
const screenReaderInstructions = {
  draggable:
    'Press Space to pick up. Use the arrow keys to move between groups. Press Space to drop or Escape to cancel.',
}

function useDebounced(value: string): string {
  const [v, setV] = useState(value)
  useEffect(() => {
    if (value === '') {
      setV('')
      return
    }
    const t = setTimeout(() => setV(value), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [value])
  return v
}

export function ChatList({ query: rawQuery }: { query: string }) {
  const query = useDebounced(rawQuery)
  const list = useListStore((s) => s.list)
  const error = useListStore((s) => s.error)
  const expanded = useListStore((s) => s.expanded)
  const collapsed = useListStore((s) => s.collapsed)
  const activeChat = useTabs((s) => {
    const p = activePlace(s)
    return p.page === 'chat' ? p.chat : null
  })
  const archivedOpen = useListStore((s) => s.showArchived)

  useEffect(() => {
    void listStore.getState().load()
    const off = subscribeListChanges()
    // Belt: window focus (and the reload action) rescans, as the Rust app does.
    const offReload = registerReloader('chat-list', () => listStore.getState().load(), [])
    return () => {
      off()
      offReload()
    }
  }, [])
  const changed = useListStore((s) => s.changed)
  const menu = useListStore((s) => s.menu)
  const renaming = useListStore((s) => s.renaming)
  const renamePending = useListStore((s) => s.renamePending)
  const rowError = useListStore((s) => s.rowError)
  const deleting = useListStore((s) => s.deleting)
  const deletingCategory = useListStore((s) => s.deletingCategory)
  const renamingCategory = useListStore((s) => s.renamingCategory)
  // The inline `New category` input; `moveId` moves that chat into the category once created.
  const [creating, setCreating] = useState<{ moveId: string | null } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ name: string; x: number; y: number } | null>(null)
  const [dropGroup, setDropGroup] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: ACTIVATION_DISTANCE } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  )

  const view = useMemo(
    () =>
      list
        ? groupChats(list.rows, Categories.fromPrefs(list.prefs), {
            query,
            collapsed,
            expanded,
          })
        : null,
    [list, collapsed, expanded, query],
  )

  const shownGroups = useMemo(() => (view ? view.groups.map((g) => g.name) : []), [view])
  const categoryNames = useMemo(
    () => (list ? Categories.fromPrefs(list.prefs).names() : []),
    [list],
  )

  const onDragOver = useCallback(({ active, over }: DragOverEvent): void => {
    const o = over?.data.current as DragData | undefined
    const a = active.data.current as DragData | undefined
    setDropGroup(o?.type === 'group' && !(a?.type === 'group' && a.name === o.name) ? o.name : null)
  }, [])
  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent): void => {
      setDropGroup(null)
      const a = active.data.current as DragData | undefined
      if (!a) return
      const drop = resolveDrop(a, (over?.data.current as DragData | undefined) ?? null, shownGroups)
      if (!drop) return
      const st = listStore.getState()
      if (drop.kind === 'assign') void st.moveChat(drop.id, drop.group)
      else void st.reorderGroups(drop.moving, drop.target)
    },
    [shownGroups],
  )

  const createCategory = async (name: string): Promise<string | null> => {
    const err = await listStore.getState().createCategory(name)
    if (err === null) {
      const moveId = creating?.moveId ?? null
      if (moveId !== null) await listStore.getState().moveChat(moveId, name.trim())
      setCreating(null)
    }
    return err
  }

  const open = (row: Row, e: MouseEvent): void =>
    openPlace(placeOf('chat', { chat: row.file }), { newTab: e.metaKey })

  const rowEl = (row: Row, group?: string, noDrag?: boolean) => (
    <ChatRow
      key={row.id}
      row={row}
      group={group}
      noDrag={noDrag}
      active={activeChat === row.file}
      changed={changed.has(row.id)}
      onOpen={open}
      onMenu={onMenu}
      renaming={renaming === row.id}
      renamePending={renaming === row.id && renamePending}
      onCommitRename={commitRename}
      onCancelRename={cancelRename}
      error={rowError?.id === row.id ? rowError.message : null}
    />
  )
  const menuRow = menu && list ? (list.rows.find((r) => r.id === menu.id) ?? null) : null
  const overlays = (
    <>
      <RowMenu
        row={menuRow}
        anchor={menu ? { x: menu.x, y: menu.y } : null}
        onClose={closeMenu}
        onRename={(r) => startRename(r.id)}
        onPin={(r) => void pin(r.id, !r.pinned)}
        onArchive={(r) => void archive(r.id, !r.archived)}
        onDelete={setDeleting}
        menuExtraItems={
          menuRow ? (
            <MoveToItem
              row={menuRow}
              groups={categoryNames}
              onMove={(r, g) => void listStore.getState().moveChat(r.id, g)}
              onNewCategory={(r) => {
                closeMenu()
                setCreating({ moveId: r.id })
              }}
            />
          ) : null
        }
      />
      <GroupMenu
        name={groupMenu?.name ?? null}
        anchor={groupMenu ? { x: groupMenu.x, y: groupMenu.y } : null}
        onClose={() => setGroupMenu(null)}
        onRename={(n) => {
          setGroupMenu(null)
          listStore.getState().setRenamingCategory(n)
        }}
        onDelete={(n) => {
          setGroupMenu(null)
          listStore.getState().setDeletingCategory(n)
        }}
      />
      <DeleteChatModal row={deleting} onClose={() => setDeleting(null)} />
      <DeleteCategoryModal
        name={deletingCategory}
        onClose={() => listStore.getState().setDeletingCategory(null)}
        onConfirm={(n) => void listStore.getState().deleteCategory(n)}
      />
    </>
  )

  if (error && (!list || list.rows.length === 0)) {
    return (
      <div className="eva-sb-empty eva-dim" role="alert" data-testid="sidebar-sub-empty">
        {error}
      </div>
    )
  }
  if (!view || !list) {
    return (
      <div className="eva-sb-empty eva-dim" data-testid="sidebar-sub-empty">
        Loading chats.
      </div>
    )
  }
  if (list.rows.length === 0) {
    return (
      <div className="eva-sb-empty" data-testid="sidebar-sub-empty">
        <div className="eva-cl-empty-heading">{EMPTY_HEADING}</div>
        <div className="eva-dim">{EMPTY_BODY}</div>
      </div>
    )
  }

  if (view.searching && view.pinned.length === 0 && view.groups.length === 0) {
    return (
      <div className="eva-sb-empty" data-testid="sidebar-sub-empty">
        <div className="eva-cl-empty-heading">{`No chats match "${query.trim()}"`}</div>
        <div className="eva-dim">Try a different title.</div>
      </div>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDropGroup(null)}
      accessibility={{ announcements, screenReaderInstructions }}
    >
      <div className="eva-cl-head">
        <span className="eva-cl-section">Categories</span>
        <ActionIcon
          variant="subtle"
          size={28}
          aria-label="New category"
          data-testid="new-category"
          onClick={() => setCreating({ moveId: null })}
        >
          <IconPlus size={16} stroke={1.5} />
        </ActionIcon>
      </div>
      <div role="tree" aria-label="Chats" className="eva-cl" data-testid="chat-tree">
        {view.pinned.length > 0 ? (
          <div role="treeitem" aria-expanded aria-selected={false} data-testid="chat-pinned">
            <div className="eva-cl-section">Pinned</div>
            <div role="group" className="eva-cl-rows">
              {view.pinned.map((r) => rowEl(r as Row))}
            </div>
          </div>
        ) : null}
        {view.groups.map((g) => (
          <div
            key={g.name}
            role="treeitem"
            aria-expanded={!g.collapsed}
            aria-selected={false}
            data-testid={`chat-section-${g.name}`}
          >
            <GroupHeader
              name={g.name}
              total={g.total}
              runningCount={g.runningCount}
              collapsed={g.collapsed}
              onToggle={() => void listStore.getState().toggleCollapsed(g.name)}
              custom={g.custom}
              dropTarget={dropGroup === g.name}
              onMenu={(name, x, y) => setGroupMenu({ name, x, y })}
              renaming={renamingCategory === g.name}
              onRename={async (from, to) => {
                const err = await listStore.getState().renameCategory(from, to)
                if (err === null) listStore.getState().setRenamingCategory(null)
                return err
              }}
              onCancelRename={() => listStore.getState().setRenamingCategory(null)}
            />
            {g.collapsed ? null : (
              <div role="group" className="eva-cl-rows">
                {g.rows.length === 0 ? (
                  <div className="eva-cl-note eva-dim">No chats in this group</div>
                ) : (
                  g.rows.map((r) => rowEl(r as Row, g.name))
                )}
                {g.hidden > 0 || expanded.has(g.name) ? (
                  <button
                    type="button"
                    className="eva-cl-more"
                    data-testid={`chat-show-more-${g.name}`}
                    onClick={() => listStore.getState().toggleExpanded(g.name)}
                  >
                    {expanded.has(g.name) ? 'Show fewer' : `Show ${g.hidden} more`}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ))}
        {creating ? (
          <div className="eva-cl-newcat" data-testid="new-category-row">
            <CategoryInput onSubmit={createCategory} onCancel={() => setCreating(null)} />
          </div>
        ) : null}
        {view.archived.length > 0 ? (
          <div role="treeitem" aria-expanded={archivedOpen} aria-selected={false}>
            <button
              type="button"
              className="eva-cl-group"
              data-testid="chat-archived-toggle"
              aria-expanded={archivedOpen}
              onClick={() => listStore.getState().toggleArchived()}
            >
              <span className="eva-cl-group-name">{`Archived (${view.archived.length})`}</span>
            </button>
            {archivedOpen ? (
              <div role="group" className="eva-cl-rows">
                {view.archived.map((r) => rowEl(r as Row, undefined, true))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {overlays}
    </DndContext>
  )
}
