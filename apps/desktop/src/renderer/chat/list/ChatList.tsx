import './chat-list.css'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { ChatRow as Row } from '@evaos/contract'
import { Categories } from '@evaos/chat-core/categories'
import { groupChats } from '@evaos/chat-core/chat-groups'
import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../../navigation/navigate'
import { activePlace, useTabs } from '../../tabs/tabs-store'
import { ChatRow } from './ChatRow'
import { GroupHeader } from './GroupHeader'
import { listStore, useListStore } from './list-store'

const EMPTY_HEADING = 'No chats yet'
const EMPTY_BODY = 'Start a new chat to talk with Eva. Your omp sessions appear here.'

export function ChatList({ query: _query }: { query: string }) {
  // Search filtering ships with the search plan; browse mode is all this slice renders.
  const list = useListStore((s) => s.list)
  const error = useListStore((s) => s.error)
  const expanded = useListStore((s) => s.expanded)
  const collapsed = useListStore((s) => s.collapsed)
  const activeChat = useTabs((s) => {
    const p = activePlace(s)
    return p.page === 'chat' ? p.chat : null
  })
  const [archivedOpen, setArchivedOpen] = useState(false)

  useEffect(() => {
    void listStore.getState().load()
  }, [])

  const view = useMemo(
    () =>
      list
        ? groupChats(list.rows, Categories.fromPrefs(list.prefs), {
            query: '',
            collapsed,
            expanded,
          })
        : null,
    [list, collapsed, expanded],
  )

  const open = (row: Row, e: MouseEvent): void =>
    openPlace(placeOf('chat', { chat: row.file }), { newTab: e.metaKey })

  const rowEl = (row: Row) => (
    <ChatRow key={row.id} row={row} active={activeChat === row.file} onOpen={open} />
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

  return (
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
            onToggle={() => listStore.getState().toggleCollapsed(g.name)}
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
            onClick={() => setArchivedOpen((o) => !o)}
          >
            <span className="eva-cl-group-name">Archived</span>
            <span className="eva-cl-badge">{view.archived.length}</span>
          </button>
          {archivedOpen ? (
            <div role="group" className="eva-cl-rows">
              {view.archived.map((r) => rowEl(r as Row))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
