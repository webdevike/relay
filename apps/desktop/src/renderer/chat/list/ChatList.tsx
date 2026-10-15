import './chat-list.css'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { ChatRow as Row } from '@evaos/contract'
import { Categories } from '@evaos/chat-core/categories'
import { groupChats } from '@evaos/chat-core/chat-groups'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../../navigation/navigate'
import { activePlace, useTabs } from '../../tabs/tabs-store'
import { ChatRow } from './ChatRow'
import { DeleteChatModal } from './DeleteChatModal'
import { RowMenu } from './RowMenu'
import { GroupHeader } from './GroupHeader'
import { registerReloader } from '../../reload/reload'
import { listStore, subscribeListChanges, useListStore } from './list-store'

const EMPTY_HEADING = 'No chats yet'
const EMPTY_BODY = 'Start a new chat to talk with Eva. Your omp sessions appear here.'

const DEBOUNCE_MS = 100

const { openMenu, closeMenu, startRename, cancelRename, commitRename, setDeleting, pin, archive } =
  listStore.getState()

const onMenu = (r: Row, x: number, y: number): void => openMenu(r.id, x, y)

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

  const open = (row: Row, e: MouseEvent): void =>
    openPlace(placeOf('chat', { chat: row.file }), { newTab: e.metaKey })

  const rowEl = (row: Row) => (
    <ChatRow
      key={row.id}
      row={row}
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
      />
      <DeleteChatModal row={deleting} onClose={() => setDeleting(null)} />
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
    <>
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
            />
            {g.collapsed ? null : (
              <div role="group" className="eva-cl-rows">
                {g.rows.length === 0 ? (
                  <div className="eva-cl-note eva-dim">No chats in this group</div>
                ) : (
                  g.rows.map((r) => rowEl(r as Row))
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
                {view.archived.map((r) => rowEl(r as Row))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {overlays}
    </>
  )
}
