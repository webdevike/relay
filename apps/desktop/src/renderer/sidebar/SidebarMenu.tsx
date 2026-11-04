import {
  IconAdjustmentsHorizontal,
  IconCheck,
  IconEye,
  IconFolder,
  IconFolderPlus,
  IconFolderSymlink,
  IconLink,
  IconPencil,
  IconStar,
  IconStarOff,
  IconTrash,
  IconExternalLink,
} from '@tabler/icons-react'
import { createPortal } from 'react-dom'
import type { Place } from '@evaos/shell-core'
import { openPlaceAt } from '../navigation/open-in-app'
import { EvaMenu } from '../overlay'
import {
  VISIBILITY_LABEL,
  favId,
  sectionKey,
  sidebarPrefsStore,
  useSidebarPrefs,
  type FavFolder,
  type FavItem,
  type SectionId,
  type Visibility,
} from './sidebar-prefs'

/** What a right click landed on. */
export type MenuTarget =
  /** A row of Main or Dashboards; `place` is where it opens, `fav` what Add to favorites stores. */
  | {
      kind: 'row'
      id: string
      section: SectionId
      place: Place
      title: string
      icon: string
    }
  /** A row that cannot be hidden (Settings): customize, copy and open only. */
  | { kind: 'fixed'; place: Place }
  | { kind: 'section'; section: SectionId }
  | { kind: 'favorites' }
  | { kind: 'favorite'; item: FavItem }
  | { kind: 'folder'; folder: FavFolder }

export interface MenuAt {
  x: number
  y: number
  target: MenuTarget
}

const ICON = { size: 16, stroke: 1.5 } as const
const ORDER: Visibility[] = ['always', 'badged', 'never']

/** `relay://open/<page>` for a top-level page, the link the app itself opens; null for others. */
export function linkFor(place: Place): string | null {
  return place.page === 'chat' || !/^[a-z0-9][a-z0-9-]*$/.test(place.page)
    ? null
    : `relay://open/${place.page}`
}

function Visibilities({ id }: { id: string }) {
  const current = useSidebarPrefs((s) => s.visibility[id] ?? 'always')
  return (
    <EvaMenu.Sub position="right-start" offset={4}>
      <EvaMenu.Sub.Target>
        <EvaMenu.Sub.Item data-testid="sidebar-menu-visibility" leftSection={<IconEye {...ICON} />}>
          Visibility
        </EvaMenu.Sub.Item>
      </EvaMenu.Sub.Target>
      <EvaMenu.Sub.Dropdown data-testid="sidebar-menu-visibility-list">
        {ORDER.map((v) => (
          <EvaMenu.Item
            key={v}
            data-testid={`sidebar-menu-vis-${v}`}
            leftSection={
              current === v ? <IconCheck {...ICON} /> : <span className="eva-sb-menu-gap" />
            }
            onClick={() => sidebarPrefsStore.getState().setVisibility(id, v)}
          >
            {VISIBILITY_LABEL[v]}
          </EvaMenu.Item>
        ))}
      </EvaMenu.Sub.Dropdown>
    </EvaMenu.Sub>
  )
}

function Customize() {
  return (
    <EvaMenu.Item
      data-testid="sidebar-menu-customize"
      leftSection={<IconAdjustmentsHorizontal {...ICON} />}
      onClick={() => sidebarPrefsStore.getState().setCustomizing(true)}
    >
      Customize sidebar
    </EvaMenu.Item>
  )
}

function Reach({ place }: { place: Place }) {
  const link = linkFor(place)
  return (
    <>
      <EvaMenu.Divider />
      {link ? (
        <EvaMenu.Item
          data-testid="sidebar-menu-copy"
          leftSection={<IconLink {...ICON} />}
          onClick={() => void navigator.clipboard.writeText(link).catch(() => {})}
        >
          Copy link
        </EvaMenu.Item>
      ) : null}
      <EvaMenu.Item
        data-testid="sidebar-menu-newtab"
        leftSection={<IconExternalLink {...ICON} />}
        onClick={() => openPlaceAt(place, 'tab')}
      >
        Open in new tab
      </EvaMenu.Item>
    </>
  )
}

export function FavoriteMenuItem({
  place,
  title,
  icon,
}: {
  place: Place
  title: string
  icon: string
}) {
  const id = favId(place.page, place.page === 'chat' ? place.chat : null)
  const has = useSidebarPrefs((s) =>
    s.favorites.some(
      (n) => n.id === id || (n.kind === 'folder' && n.items.some((i) => i.id === id)),
    ),
  )
  return (
    <EvaMenu.Item
      data-testid="sidebar-menu-favorite"
      leftSection={has ? <IconStarOff {...ICON} /> : <IconStar {...ICON} />}
      onClick={() => {
        const s = sidebarPrefsStore.getState()
        if (has) s.removeFavorite(id)
        else
          s.addFavorite({
            page: place.page,
            chat: place.page === 'chat' ? place.chat : null,
            title,
            icon,
          })
      }}
    >
      {has ? 'Remove from favorites' : 'Add to favorites'}
    </EvaMenu.Item>
  )
}

function MoveTo({ item }: { item: FavItem }) {
  const favorites = useSidebarPrefs((s) => s.favorites)
  const folders = favorites.filter((n): n is FavFolder => n.kind === 'folder')
  if (folders.length === 0) return null
  const inside = folders.find((f) => f.items.some((i) => i.id === item.id))?.id ?? null
  return (
    <EvaMenu.Sub position="right-start" offset={4}>
      <EvaMenu.Sub.Target>
        <EvaMenu.Sub.Item
          data-testid="sidebar-menu-move"
          leftSection={<IconFolderSymlink {...ICON} />}
        >
          Move to folder
        </EvaMenu.Sub.Item>
      </EvaMenu.Sub.Target>
      <EvaMenu.Sub.Dropdown data-testid="sidebar-menu-move-list">
        {inside !== null ? (
          <EvaMenu.Item
            data-testid="sidebar-menu-move-none"
            onClick={() => sidebarPrefsStore.getState().moveToFolder(item.id, null)}
          >
            No folder
          </EvaMenu.Item>
        ) : null}
        {folders
          .filter((f) => f.id !== inside)
          .map((f) => (
            <EvaMenu.Item
              key={f.id}
              leftSection={<IconFolder {...ICON} />}
              onClick={() => sidebarPrefsStore.getState().moveToFolder(item.id, f.id)}
            >
              {f.name}
            </EvaMenu.Item>
          ))}
      </EvaMenu.Sub.Dropdown>
    </EvaMenu.Sub>
  )
}

const favoritePlace = (i: FavItem): Place => ({
  page: i.page,
  chat: i.chat,
  settingsSection: 'Theme',
  meeting: null,
  canvas: null,
})

/**
 * The one right-click menu of the sidebar, portalled to the body (the sidebar is a containing
 * block for fixed children, which would shift the anchor away from the pointer).
 */
export function SidebarMenu({
  at,
  onClose,
  onRenameFolder,
  onNewFolder,
}: {
  at: MenuAt | null
  onClose: () => void
  onRenameFolder: (id: string) => void
  onNewFolder: () => void
}) {
  const t = at?.target
  return createPortal(
    <EvaMenu
      opened={at !== null}
      onChange={(o) => {
        if (!o) onClose()
      }}
      width={240}
      position="bottom-start"
      offset={0}
    >
      <EvaMenu.Target>
        <span
          className="eva-sb-menu-anchor"
          style={{ left: at?.x ?? 0, top: at?.y ?? 0 }}
          aria-hidden
        />
      </EvaMenu.Target>
      <EvaMenu.Dropdown className="eva-sb-menu" data-testid="sidebar-menu">
        {t?.kind === 'row' ? (
          <>
            <Visibilities id={t.id} />
            <Customize />
            <FavoriteMenuItem place={t.place} title={t.title} icon={t.icon} />
            <Reach place={t.place} />
          </>
        ) : t?.kind === 'fixed' ? (
          <>
            <Customize />
            <Reach place={t.place} />
          </>
        ) : t?.kind === 'section' ? (
          <>
            <Visibilities id={sectionKey(t.section)} />
            <Customize />
          </>
        ) : t?.kind === 'favorites' ? (
          <>
            <EvaMenu.Item
              data-testid="sidebar-menu-new-folder"
              leftSection={<IconFolderPlus {...ICON} />}
              onClick={onNewFolder}
            >
              New folder
            </EvaMenu.Item>
            <Customize />
          </>
        ) : t?.kind === 'favorite' ? (
          <>
            <MoveTo item={t.item} />
            <EvaMenu.Item
              data-testid="sidebar-menu-unfavorite"
              leftSection={<IconStarOff {...ICON} />}
              onClick={() => sidebarPrefsStore.getState().removeFavorite(t.item.id)}
            >
              Remove from favorites
            </EvaMenu.Item>
            <Customize />
            <Reach place={favoritePlace(t.item)} />
          </>
        ) : t?.kind === 'folder' ? (
          <>
            <EvaMenu.Item
              data-testid="sidebar-menu-rename-folder"
              leftSection={<IconPencil {...ICON} />}
              onClick={() => onRenameFolder(t.folder.id)}
            >
              Rename folder
            </EvaMenu.Item>
            <EvaMenu.Item
              data-testid="sidebar-menu-delete-folder"
              className="eva-sb-menu-danger"
              leftSection={<IconTrash {...ICON} />}
              onClick={() => sidebarPrefsStore.getState().deleteFolder(t.folder.id)}
            >
              Delete folder
            </EvaMenu.Item>
            <Customize />
          </>
        ) : null}
      </EvaMenu.Dropdown>
    </EvaMenu>,
    document.body,
  )
}
