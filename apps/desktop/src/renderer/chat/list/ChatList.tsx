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
import { Accordion, ActionIcon, SegmentedControl, UnstyledButton } from '@mantine/core'
import { IconChevronRight, IconPlus } from '@tabler/icons-react'
import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { ChatAgentSchema, type ChatAgent, type ChatRow as Row } from '@evaos/contract'
import { Categories } from '@evaos/chat-core/categories'
import { placeOf } from '@evaos/shell-core'
import { openFromNav } from '../../navigation/open-in-app'
import { activePlace, useTabs } from '../../tabs/tabs-store'
import { ChatRow } from './ChatRow'
import { DeleteChatModal } from './DeleteChatModal'
import { MoveToItem, RowMenu } from './RowMenu'
import { FavoriteMenuItem } from '../../sidebar/SidebarMenu'
import { CategoryInput } from './CategoryInput'
import { DeleteCategoryModal } from './DeleteCategoryModal'
import { ACTIVATION_DISTANCE, folderKeyboardCoordinates, resolveDrop, type DragData } from './dnd'
import { GroupMenu } from './GroupMenu'
import { GroupHeader } from './GroupHeader'
import { registerReloader } from '../../reload/reload'
import { listStore, subscribeListChanges, useListStore } from './list-store'
import { folderShown, folders, isRead, isSettled, isWorking, split, type Folder } from './look'
import { useProfile } from '../../pages/profile'

const DEBOUNCE_MS = 100
/** The clock ticks every second while a chat works (for "Working 16s"), else every minute. */
const TICK_WORKING_MS = 1000
const TICK_IDLE_MS = 60_000
/** Accordion item values: a workspace folder, or the Snoozed / Settled fold. */
const GROUP = 'group:'
const FOLD = 'fold:'

const {
  openMenu,
  closeMenu,
  startRename,
  cancelRename,
  commitRename,
  setDeleting,
  pin,
  settle,
  snooze,
  markRead,
} = listStore.getState()

const onMenu = (r: Row, x: number, y: number): void => openMenu(r.id, x, y)
const onSnooze = (r: Row, untilMs: number | null): void => void snooze(r.id, untilMs)
const onSettle = (r: Row, settled: boolean): void => void settle(r.id, settled)

// A pointer drops on the folder under it; the keyboard sensor has no pointer, so it takes the
// nearest folder header.
const collision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)

const announcements = {
  onDragStart: (): string => 'Picked up a chat.',
  onDragOver: ({ over }: { over: { data: { current?: unknown } } | null }): string => {
    const d = over?.data.current as DragData | undefined
    return d?.type === 'group' ? `Over the ${d.name} folder.` : 'Not over a folder.'
  },
  onDragEnd: ({ over }: { over: { data: { current?: unknown } } | null }): string => {
    const d = over?.data.current as DragData | undefined
    return d?.type === 'group' ? `Dropped on the ${d.name} folder.` : 'Dropped. Nothing changed.'
  },
  onDragCancel: (): string => 'Move cancelled.',
}
const screenReaderInstructions = {
  draggable:
    'Press Space to pick up. Use the arrow keys to move between folders. Press Space to drop or Escape to cancel.',
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

/** The list's clock: re-renders every second while any chat works, else every minute. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ticking ? TICK_WORKING_MS : TICK_IDLE_MS)
    return () => clearInterval(t)
  }, [ticking])
  return now
}

/** `footer`, when given, holds the Settled fold pinned below the scrolling list; else it trails inline. */
export function ChatList({
  query: rawQuery,
  footer = null,
}: {
  query: string
  footer?: HTMLElement | null
}) {
  const query = useDebounced(rawQuery).trim().toLowerCase()
  const searching = query !== ''
  const list = useListStore((s) => s.list)
  const error = useListStore((s) => s.error)
  const expanded = useListStore((s) => s.expanded)
  const collapsed = useListStore((s) => s.collapsed)
  const snoozedOpen = useListStore((s) => s.showSnoozed) || searching
  const settledOpen = useListStore((s) => s.showSettled) || searching
  const activeChat = useTabs((s) => {
    const p = activePlace(s)
    return p.page === 'chat' ? p.chat : null
  })

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
      coordinateGetter: folderKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  )

  const agent = list?.prefs.chat_agent ?? 'Eva'
  const starter = useProfile() === 'starter'
  const cats = useMemo(() => (list ? Categories.fromPrefs(list.prefs) : null), [list])
  const categoryOf = useCallback(
    (r: Row): string => cats?.categoryOf(r.id, r.title, r.workedIn) ?? '',
    [cats],
  )
  // A chat an assistant started (auto-work) lives under that assistant's thread, not here.
  const rows = useMemo(
    () =>
      list
        ? list.rows.filter(
            (r) =>
              r.owner === null &&
              r.agent === agent &&
              (!searching || r.title.toLowerCase().includes(query)),
          )
        : [],
    [list, agent, searching, query],
  )
  const now = useNow(rows.some(isWorking))
  const lists = useMemo(() => split(rows, now), [rows, now])
  const shownFolders = useMemo((): Folder[] => {
    const out = folders(lists.list, categoryOf)
    if (searching || !cats) return out
    // Electron's own empty categories stay listed as drop targets, after the busy folders.
    for (const name of cats.names()) {
      if (cats.isCustom(name) && !out.some((f) => f.name === name)) {
        out.push({ name, rows: [], hint: null })
      }
    }
    return out
  }, [lists, categoryOf, searching, cats])

  // Native mark_read: a chat that is shown counts as read, also when it returns while shown.
  const activeRow = list?.rows.find((r) => r.file === activeChat) ?? null
  useEffect(() => {
    if (activeRow && (!isRead(activeRow) || activeRow.wokeMs !== null)) void markRead(activeRow.id)
  }, [activeRow])

  const onDragOver = useCallback(({ active, over }: DragOverEvent): void => {
    const o = over?.data.current as DragData | undefined
    const a = active.data.current as DragData | undefined
    setDropGroup(o?.type === 'group' && a?.type === 'chat' && a.group !== o.name ? o.name : null)
  }, [])
  const onDragEnd = useCallback(({ active, over }: DragEndEvent): void => {
    setDropGroup(null)
    const a = active.data.current as DragData | undefined
    if (!a) return
    const drop = resolveDrop(a, (over?.data.current as DragData | undefined) ?? null)
    if (drop) void listStore.getState().moveChat(drop.id, drop.group)
  }, [])

  const createCategory = async (name: string): Promise<string | null> => {
    const err = await listStore.getState().createCategory(name)
    if (err === null) {
      const moveId = creating?.moveId ?? null
      if (moveId !== null) await listStore.getState().moveChat(moveId, name.trim())
      setCreating(null)
    }
    return err
  }

  const open = (row: Row, e: MouseEvent | KeyboardEvent): void => {
    void markRead(row.id)
    openFromNav(placeOf('chat', { chat: row.file }), e)
  }

  const rowEl = (row: Row, opts: { nested: boolean; settled?: boolean; group?: string }) => (
    <ChatRow
      key={row.id}
      row={row}
      category={categoryOf(row)}
      nested={opts.nested}
      settled={opts.settled ?? false}
      now={now}
      group={opts.group}
      noDrag={opts.group === undefined}
      active={activeChat === row.file}
      changed={changed.has(row.id)}
      onOpen={open}
      onMenu={onMenu}
      onSnooze={onSnooze}
      onSettle={onSettle}
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
        settled={menuRow !== null && isSettled(menuRow, now)}
        anchor={menu ? { x: menu.x, y: menu.y } : null}
        onClose={closeMenu}
        onRename={(r) => startRename(r.id)}
        onPin={(r) => void pin(r.id, !r.pinned)}
        onSnooze={onSnooze}
        onSettle={onSettle}
        onDelete={setDeleting}
        menuExtraItems={
          menuRow ? (
            <>
              <FavoriteMenuItem
                place={placeOf('chat', { chat: menuRow.file })}
                title={menuRow.title}
                icon="IconMessage"
              />
              {cats ? (
                <MoveToItem
                  row={menuRow}
                  groups={cats.names()}
                  onMove={(r, g) => void listStore.getState().moveChat(r.id, g)}
                  onNewCategory={(r) => {
                    closeMenu()
                    setCreating({ moveId: r.id })
                  }}
                />
              ) : null}
            </>
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
  if (!list || !cats) {
    return (
      <div className="eva-sb-empty eva-dim" data-testid="sidebar-sub-empty">
        Loading chats.
      </div>
    )
  }

  // Native agent_switcher: every agent's chats counted, settled too; empty tabs hidden except
  // Eva and the selected one.
  const counts = new Map<ChatAgent, number>()
  for (const r of list.rows)
    if (r.owner === null) counts.set(r.agent, (counts.get(r.agent) ?? 0) + 1)
  const tabs = ChatAgentSchema.options.filter(
    (a) => (counts.get(a) ?? 0) > 0 || a === 'Eva' || a === agent,
  )
  const switcher = (
    <div className="eva-cl-agent-wrap">
      {/* A starter home has one chat agent: a lone "Eva" tab only names Isaac's setup. */}
      {starter && tabs.length <= 1 ? null : (
        <SegmentedControl
          className="eva-cl-agents"
          data-testid="chat-agents"
          size="xs"
          fullWidth
          value={agent}
          onChange={(v) => void listStore.getState().setAgent(ChatAgentSchema.parse(v))}
          data={tabs.map((a) => ({
            value: a,
            label: (
              <span className="eva-cl-agent" data-testid={`chat-agent-${a.toLowerCase()}`}>
                {a}
                <span className="eva-cl-count">{counts.get(a) ?? 0}</span>
              </span>
            ),
          }))}
        />
      )}
      <ActionIcon
        className="eva-cl-new-category"
        variant="subtle"
        size={24}
        aria-label="New category"
        title="New category"
        data-testid="new-category"
        onClick={() => setCreating({ moveId: null })}
      >
        <IconPlus size={14} stroke={1.5} />
      </ActionIcon>
    </div>
  )
  if (list.rows.length === 0) {
    return (
      <>
        {switcher}
        <div className="eva-cl-empty eva-dim" data-testid="sidebar-sub-empty">
          No chats in this repo yet.
        </div>
      </>
    )
  }
  if (searching && rows.length === 0) {
    return (
      <>
        {switcher}
        <div className="eva-cl-empty eva-dim" data-testid="sidebar-sub-empty">
          No chats match.
        </div>
      </>
    )
  }

  // Collapse always honors the click; only a search forces every folder and fold open. A
  // collapsed folder still shows its status hint in the header.
  const openValues = [
    ...shownFolders
      .filter((f) => searching || !collapsed.has(f.name))
      .map((f) => `${GROUP}${f.name}`),
    ...(snoozedOpen ? [`${FOLD}snoozed`] : []),
    ...(settledOpen ? [`${FOLD}settled`] : []),
  ]
  const onAccordion = (next: string[]): void => {
    if (searching) return
    const toggled = [
      ...openValues.filter((v) => !next.includes(v)),
      ...next.filter((v) => !openValues.includes(v)),
    ]
    for (const v of toggled) {
      if (v.startsWith(GROUP)) void listStore.getState().toggleCollapsed(v.slice(GROUP.length))
      else if (v === `${FOLD}snoozed`) listStore.getState().toggleSnoozed()
      else if (v === `${FOLD}settled`) listStore.getState().toggleSettled()
    }
  }

  const fold = (id: 'snoozed' | 'settled', label: string, rowsIn: Row[], settled: boolean) => (
    <Accordion.Item value={`${FOLD}${id}`} className="eva-cl-section">
      <Accordion.Control className="eva-cl-fold" data-testid={`chat-${id}-toggle`}>
        <span>{`${label} (${rowsIn.length})`}</span>
        <span className="eva-cl-fold-line" aria-hidden />
      </Accordion.Control>
      <Accordion.Panel>{rowsIn.map((r) => rowEl(r, { nested: false, settled }))}</Accordion.Panel>
    </Accordion.Item>
  )

  return (
    <nav className="eva-cl-root" aria-label="Chats" data-testid="chat-list">
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDropGroup(null)}
        accessibility={{ announcements, screenReaderInstructions }}
      >
        {switcher}
        <Accordion
          unstyled
          multiple
          value={openValues}
          onChange={onAccordion}
          // Instant, as before: closed panels unmount, so hidden rows never count or take drops.
          transitionDuration={0}
          keepMounted={false}
          chevronPosition="left"
          chevron={<IconChevronRight size={12} stroke={1.75} aria-hidden />}
          classNames={{
            root: 'eva-cl',
            chevron: 'eva-cl-chev',
            label: 'eva-cl-control-label',
            content: 'eva-cl-rows',
          }}
          data-testid="chat-tree"
        >
          {lists.pinned.map((r) => rowEl(r, { nested: false }))}
          {shownFolders.map((f) => {
            const more = expanded.has(f.name)
            const shown = folderShown(f.rows.length, more, searching)
            return (
              <Accordion.Item
                key={f.name}
                value={`${GROUP}${f.name}`}
                className="eva-cl-section"
                data-testid={`chat-section-${f.name}`}
              >
                <GroupHeader
                  name={f.name}
                  count={f.rows.length}
                  hint={f.hint}
                  custom={cats.isCustom(f.name)}
                  dropTarget={dropGroup === f.name}
                  onMenu={(name, x, y) => setGroupMenu({ name, x, y })}
                  renaming={renamingCategory === f.name}
                  onRename={async (from, to) => {
                    const err = await listStore.getState().renameCategory(from, to)
                    if (err === null) listStore.getState().setRenamingCategory(null)
                    return err
                  }}
                  onCancelRename={() => listStore.getState().setRenamingCategory(null)}
                />
                <Accordion.Panel className="eva-cl-nested">
                  {f.rows.length === 0 ? (
                    <div className="eva-cl-note">No chats in this group</div>
                  ) : (
                    f.rows.slice(0, shown).map((r) => rowEl(r, { nested: true, group: f.name }))
                  )}
                  {!searching && (f.rows.length > shown || more) ? (
                    <UnstyledButton
                      className="eva-cl-more"
                      data-testid={`chat-show-more-${f.name}`}
                      onClick={() => listStore.getState().toggleExpanded(f.name)}
                    >
                      {more ? 'Show fewer' : `Show ${f.rows.length - shown} more`}
                    </UnstyledButton>
                  ) : null}
                </Accordion.Panel>
              </Accordion.Item>
            )
          })}
          {creating ? (
            <div className="eva-cl-newcat" data-testid="new-category-row">
              <CategoryInput onSubmit={createCategory} onCancel={() => setCreating(null)} />
            </div>
          ) : null}
          {lists.snoozed.length > 0 ? fold('snoozed', 'Snoozed', lists.snoozed, false) : null}
          {lists.settled.length > 0
            ? footer
              ? createPortal(fold('settled', 'Settled', lists.settled, true), footer)
              : fold('settled', 'Settled', lists.settled, true)
            : null}
        </Accordion>
        {overlays}
      </DndContext>
    </nav>
  )
}
