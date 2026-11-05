import relayIcon from '../assets/brand/relay-icon.png'
import { ActionIcon, Tooltip } from '@mantine/core'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { IconFolderPlus } from '@tabler/icons-react'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { placeOf, type Place } from '@evaos/shell-core'
import { useBoards } from '../boards/boards-store'
import { canvasNavPlace } from '../canvas/canvas-store'
import { bright, isSnoozed } from '../chat/list/look'
import { listStore, subscribeListChanges, useListStore } from '../chat/list/list-store'
import { openFromNav } from '../navigation/open-in-app'
import { navTargetOf, type ClickMods } from '../navigation/open-target'
import { NAV_PAGES } from '../pages/page-meta'
import { STARTER_SLUGS, useProfile } from '../pages/profile'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { brandTooltip, useAbout } from '../about/build-info'
import { ScrollArea } from '../ui/ScrollArea'
import { ListRow, ListView, type ActivateEvent, type ListGroup } from '../ui/list'
import { CustomizeSidebarModal, type CustomizeSection } from './CustomizeSidebarModal'
import { FavRow, favEntries, type FavEntry } from './FavoritesRows'
import { navIcon } from './icons'
import './customize.css'
import { NavRow } from './NavRow'
import { UpdateBadge } from '../update/UpdateBadge'
import { openSub } from './nav-level'
import { SidebarMenu, type MenuAt, type MenuTarget } from './SidebarMenu'
import {
  FAVORITES_ID,
  SECTION_TITLE,
  inOrder,
  isShown,
  sectionKey,
  sidebarPrefsStore,
  useSidebarPrefs,
  type FavItem,
  type FavNode,
  type SectionId,
} from './sidebar-prefs'
import { countLabel, useSidebarData } from './sidebar-store'

// The built-in Dashboard sits first under Dashboards as Overview (native sidebar::dashboards).
const MAIN = NAV_PAGES.filter((n) => n.slug !== 'setting' && n.slug !== 'dashboard')
const OVERVIEW = NAV_PAGES.find((n) => n.slug === 'dashboard')!
const SETTING = NAV_PAGES.find((n) => n.slug === 'setting')!

/** A row of Main or Dashboards. `id` is what the user's visibility and order are keyed by. */
interface Item {
  id: string
  title: string
  icon: string
  page: Place['page']
}

/** One drawn row of the sidebar's single list. */
type Entry =
  | { kind: 'nav'; item: Item }
  | { kind: 'dash'; item: Item }
  | { kind: 'fav'; fav: FavEntry }

const entryKey = (e: Entry): string => (e.kind === 'fav' ? e.fav.node.id : `${e.kind}:${e.item.id}`)

export function MainNav() {
  const about = useAbout()
  const here = useTabs(activePlace)
  const jobs = useSidebarData((s) => s.scheduledJobs)
  const error = useSidebarData((s) => s.error)
  const boards = useBoards((s) => s.data?.boards ?? null)
  const profile = useProfile()
  const chatRows = useListStore((s) => s.list?.rows ?? null)
  const prefs = {
    badgeStyle: useSidebarPrefs((s) => s.badgeStyle),
    visibility: useSidebarPrefs((s) => s.visibility),
    order: useSidebarPrefs((s) => s.order),
    collapsed: useSidebarPrefs((s) => s.collapsed),
    favorites: useSidebarPrefs((s) => s.favorites),
  }
  const customizing = useSidebarPrefs((s) => s.customizing)
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Chat's badge counts the chats that came back unread or wait on Isaac.
  useEffect(() => {
    if (listStore.getState().list === null) void listStore.getState().load()
    return subscribeListChanges()
  }, [])
  const unreadChats = useMemo(
    () =>
      (chatRows ?? []).filter((r) => r.owner === null && !r.archived && !isSnoozed(r) && bright(r))
        .length,
    [chatRows],
  )
  const chatTitle = useMemo(
    () => new Map((chatRows ?? []).map((r) => [r.file, r.title])),
    [chatRows],
  )

  const badgeOf = (id: string): number =>
    id === 'jobs' ? (error ? 0 : jobs) : id === 'chat' ? unreadChats : 0

  const mainItems = useMemo(
    () =>
      inOrder(
        MAIN.filter((n) => profile === 'eva' || STARTER_SLUGS[n.slug]).map((n): Item => ({
          id: n.slug,
          title: n.title,
          icon: n.icon,
          page: n.page,
        })),
        prefs.order['main'],
      ),
    [profile, prefs.order],
  )
  const dashItems = useMemo(
    () =>
      inOrder(
        [
          { id: OVERVIEW.slug, title: 'Overview', icon: OVERVIEW.icon, page: OVERVIEW.page },
          ...(boards ?? []).map((b): Item => ({
            id: `board-${b.slug}`,
            title: b.title,
            icon: b.icon ?? 'IconLayoutDashboard',
            page: `board:${b.slug}` as Place['page'],
          })),
        ],
        prefs.order['dashboards'],
      ),
    [boards, prefs.order],
  )

  const sections: Record<SectionId, Item[]> = { main: mainItems, dashboards: dashItems }
  /** Rows drawn in a section: shown by their own visibility, and the section by its own. */
  const drawn = (id: SectionId): Item[] => {
    const rows = sections[id].filter((i) => isShown(prefs.visibility[i.id], badgeOf(i.id) > 0))
    const sv = prefs.visibility[sectionKey(id)]
    return isShown(
      sv,
      rows.some((i) => badgeOf(i.id) > 0),
    )
      ? rows
      : []
  }

  const go = (page: Place['page'], e: ClickMods): void => {
    const here_ = navTargetOf(e) === 'here'
    const nav = (p: Place): void => openFromNav(p, e)
    if (page === 'assistants') {
      nav(placeOf('assistants'))
      openSub('assistants')
    } else if (page === 'chat') {
      // A plain click on Chat while already on a chat only drills in.
      if (!(here.page === 'chat' && here_)) nav(placeOf('chat'))
      openSub('chats')
    } else if (page === 'meetings') {
      nav(placeOf('meetings'))
      openSub('meetings')
    } else if (page === 'reviews') {
      nav(placeOf('reviews'))
      openSub('reviews')
    } else if (page === 'canvas') {
      // A plain click while on a board only drills in.
      if (!(here.page === 'canvas' && here_)) nav(canvasNavPlace())
      openSub('canvas')
    } else if (page === 'settings') {
      nav(placeOf('settings', { settingsSection: 'Theme' }))
      openSub('settings')
    } else {
      nav(placeOf(page))
    }
  }

  const openAt = (x: number, y: number, target: MenuTarget): void => setMenu({ x, y, target })
  const rowMenu = (section: SectionId, i: Item) => (x: number, y: number) =>
    openAt(x, y, {
      kind: 'row',
      id: i.id,
      section,
      place: placeOf(i.page),
      title: i.title,
      icon: i.icon,
    })
  const favMenu = (node: FavNode, x: number, y: number): void =>
    openAt(
      x,
      y,
      node.kind === 'folder' ? { kind: 'folder', folder: node } : { kind: 'favorite', item: node },
    )
  const openFavorite = (item: FavItem, e: ActivateEvent): void =>
    openFromNav(placeOf(item.page, item.chat === null ? {} : { chat: item.chat }), e)
  const newFolder = (): void => setRenaming(sidebarPrefsStore.getState().addFolder('New folder'))

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (over && active.id !== over.id) {
      sidebarPrefsStore.getState().dropFavorite(String(active.id), String(over.id))
    }
  }

  const favorites = favEntries(prefs.favorites)
  const groups: ListGroup<Entry>[] = []
  const mainRows = drawn('main')
  if (mainRows.length > 0) {
    groups.push({
      id: 'main',
      label: SECTION_TITLE.main,
      count: null,
      testid: 'sidebar-section-main',
      items: mainRows.map((item): Entry => ({ kind: 'nav', item })),
    })
  }
  if (prefs.favorites.length > 0) {
    groups.push({
      id: FAVORITES_ID,
      label: 'Favorites',
      count: null,
      testid: 'sidebar-favorites',
      actions: (
        <Tooltip label="New folder" openDelay={300}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="New folder"
            data-testid="favorites-new-folder"
            onClick={newFolder}
          >
            <IconFolderPlus size={14} stroke={1.5} />
          </ActionIcon>
        </Tooltip>
      ),
      items: favorites.map((fav): Entry => ({ kind: 'fav', fav })),
    })
  }
  const dashRows = drawn('dashboards')
  if (dashRows.length > 0) {
    groups.push({
      id: 'dashboards',
      label: SECTION_TITLE.dashboards,
      count: null,
      testid: 'sidebar-dashboards',
      items: dashRows.map((item): Entry => ({ kind: 'dash', item })),
    })
  }

  const customize: CustomizeSection[] = (['main', 'dashboards'] as const).map((id) => ({
    id,
    title: SECTION_TITLE[id],
    items: sections[id].map(({ id: rid, title, icon }) => ({ id: rid, title, icon })),
  }))

  const renderRow = (entry: Entry) => {
    if (entry.kind === 'fav') {
      const node = entry.fav.node
      const chat = node.kind === 'item' ? node.chat : null
      const title =
        node.kind === 'folder'
          ? node.name
          : ((chat !== null ? chatTitle.get(chat) : undefined) ?? node.title)
      const active =
        node.kind === 'item' &&
        here.page === node.page &&
        (node.page !== 'chat' || here.chat === node.chat)
      return (
        <FavRow
          key={node.id}
          entry={entry.fav}
          title={title}
          active={active}
          renaming={renaming === node.id}
          onOpen={openFavorite}
          onMenu={favMenu}
          onRenameDone={() => setRenaming(null)}
        />
      )
    }
    const n = entry.item
    if (entry.kind === 'dash') {
      const Glyph = navIcon(n.icon)
      const active = here.page === n.page
      return (
        <ListRow
          key={n.id}
          data-testid={`nav-${n.id}`}
          active={active}
          aria-current={active ? 'page' : undefined}
          leading={<Glyph size={16} aria-hidden />}
          title={n.title}
          onActivate={(e) => go(n.page, e)}
          middleClick
          onMenu={rowMenu('dashboards', n)}
        />
      )
    }
    const count = badgeOf(n.id)
    return (
      <NavRow
        key={n.id}
        slug={n.id}
        title={n.title}
        icon={n.icon}
        active={
          here.page === n.page ||
          (n.id === 'assistants' && here.page.startsWith('agent:')) ||
          (n.id === 'reviews' && here.page.startsWith('review:'))
        }
        count={prefs.badgeStyle === 'count' ? countLabel(count) : null}
        dot={prefs.badgeStyle === 'dot' && count > 0}
        countTestid={n.id === 'jobs' ? 'count-jobs' : n.id === 'chat' ? 'count-chat' : undefined}
        chevron={
          n.id === 'assistants' ||
          n.id === 'chat' ||
          n.id === 'canvas' ||
          n.id === 'meetings' ||
          n.id === 'reviews'
        }
        onClick={(e: MouseEvent<HTMLButtonElement>) => go(n.page, e)}
        onMenu={rowMenu('main', n)}
      />
    )
  }

  /** A right click on a section header (rows handle their own and mark the event handled). */
  const onHeaderMenu = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented) return
    const el = e.target as HTMLElement
    if (el.closest('.eva-list-gactions') || !el.closest('.eva-list-ghead')) return
    const id = el.closest<HTMLElement>('[data-list-group]')?.dataset['listGroup']
    if (id === undefined) return
    e.preventDefault()
    openAt(
      e.clientX,
      e.clientY,
      id === FAVORITES_ID ? { kind: 'favorites' } : { kind: 'section', section: id as SectionId },
    )
  }

  return (
    <div className="eva-sb-page" data-testid="sidebar-main">
      <div className="eva-sb-header">
        <Tooltip
          label={brandTooltip(about?.build ?? null, __RELAY_BUILT_AT__)}
          position="bottom-start"
          openDelay={400}
          withinPortal
        >
          <div className="eva-sb-brand">
            <img className="eva-sb-logo" src={relayIcon} alt="" aria-hidden draggable={false} />
            <span className="eva-sb-brand-name">Relay</span>
          </div>
        </Tooltip>
      </div>
      <div className="eva-sb-scroll">
        <ScrollArea data-testid="sidebar-scroll">
          <DndContext sensors={sensors} onDragEnd={onDragEnd}>
            <div className="eva-sb-sections" onContextMenu={onHeaderMenu}>
              <ListView<Entry>
                density="compact"
                groups={groups}
                rowKey={entryKey}
                renderRow={renderRow}
                collapsed={new Set(Object.keys(prefs.collapsed))}
                onCollapsedChange={(id) => sidebarPrefsStore.getState().toggleCollapsed(id)}
              />
            </div>
          </DndContext>
        </ScrollArea>
      </div>
      <div className="eva-sb-footer" data-testid="sidebar-footer">
        {error ? (
          <div className="eva-sb-error eva-dim" data-testid="sidebar-error">
            Could not read counts. Press the refresh shortcut to try again.
          </div>
        ) : null}
        <UpdateBadge />
        <NavRow
          slug={SETTING.slug}
          title={SETTING.title}
          icon={SETTING.icon}
          active={here.page === 'settings'}
          onClick={(e) => go('settings', e)}
          onMenu={(x, y) => openAt(x, y, { kind: 'fixed', place: placeOf('settings') })}
        />
      </div>
      <SidebarMenu
        at={menu}
        onClose={() => setMenu(null)}
        onRenameFolder={(id) => {
          setMenu(null)
          setRenaming(id)
        }}
        onNewFolder={() => {
          setMenu(null)
          newFolder()
        }}
      />
      <CustomizeSidebarModal
        sections={customize}
        opened={customizing}
        onClose={() => sidebarPrefsStore.getState().setCustomizing(false)}
      />
    </div>
  )
}
