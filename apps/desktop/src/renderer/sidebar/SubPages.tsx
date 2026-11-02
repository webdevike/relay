import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import {
  IconChevronLeft,
  IconEdit,
  IconInfoCircle,
  IconLink,
  IconMessage,
  IconPalette,
  IconPlus,
} from '@tabler/icons-react'
import { useState, type MouseEvent } from 'react'
import { SETTINGS_SECTIONS, placeOf, type SettingsSection } from '@evaos/shell-core'
import { AssistantsList } from '../assistants/AssistantsList'
import { CanvasList } from '../canvas/CanvasList'
import { newBoard } from '../canvas/canvas-store'
import { openPlace } from '../navigation/navigate'
import { activePlace, newChatTab, useTabs } from '../tabs/tabs-store'
import { ScrollArea } from '../ui/ScrollArea'
import { MeetingsList } from '../meetings/MeetingsList'
import { ReviewsList } from '../reviews/ReviewsList'
import { ChatList } from '../chat/list/ChatList'
import { SearchBox } from './SearchBox'
import { backToRoot, type NavLevel } from './nav-level'

const SECTION_ICON = {
  Theme: IconPalette,
  Chat: IconMessage,
  Links: IconLink,
  About: IconInfoCircle,
} as const

const COPY = {
  chats: { title: 'Chats', search: 'Search chats' },
  canvas: { title: 'Canvas', search: 'Search boards' },
  meetings: { title: 'Meetings', search: 'Search meetings' },
} as const

export function SubPage({ level }: { level: Exclude<NavLevel, 'root'> }) {
  const here = useTabs(activePlace)
  const [query, setQuery] = useState('')
  // The chats page pins its Settled fold here, below the scrolling list.
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  const copy =
    level === 'settings' || level === 'assistants' || level === 'reviews' ? null : COPY[level]
  const title = copy
    ? copy.title
    : level === 'assistants'
      ? 'Assistants'
      : level === 'reviews'
        ? 'Reviews'
        : 'Settings'

  const pick = (section: SettingsSection, e: MouseEvent): void => {
    openPlace(placeOf('settings', { settingsSection: section }), { newTab: e.metaKey })
  }

  return (
    <div
      className="eva-sb-page"
      data-testid={`sidebar-sub-${level}`}
      data-level={level}
      role="region"
      aria-label={title}
    >
      <div className="eva-sb-header">
        <Tooltip
          label={
            <span>
              Back to menu <Kbd size="xs">Esc</Kbd>
            </span>
          }
        >
          <button
            type="button"
            className="eva-sb-row"
            data-testid="sidebar-back"
            onClick={backToRoot}
          >
            <IconChevronLeft size={16} aria-hidden />
            <span className="eva-sb-row-label">Back</span>
          </button>
        </Tooltip>
        <div className="eva-sb-sub-title">
          {level === 'assistants' ? (
            <button
              type="button"
              className="eva-sb-title-btn"
              data-testid="assistants-home-link"
              onClick={(e) => openPlace(placeOf('assistants'), { newTab: e.metaKey })}
            >
              {title}
            </button>
          ) : level === 'meetings' ? (
            <button
              type="button"
              className="eva-sb-title-btn"
              data-testid="meetings-home"
              onClick={(e) => openPlace(placeOf('meetings'), { newTab: e.metaKey })}
            >
              {title}
            </button>
          ) : (
            <h2 className="eva-sb-title" data-testid="sidebar-sub-title">
              {title}
            </h2>
          )}
          {level === 'chats' ? (
            <ActionIcon
              variant="subtle"
              size="var(--eva-kit-control-sm)"
              aria-label="New chat"
              data-testid="chat-new"
              onClick={newChatTab}
            >
              <IconEdit size="calc(var(--eva-font-size) * .875)" stroke={1.5} />
            </ActionIcon>
          ) : level === 'canvas' ? (
            <ActionIcon
              variant="subtle"
              size="var(--eva-kit-control-sm)"
              aria-label="New board"
              data-testid="canvas-new"
              onClick={(e) => void newBoard(e.metaKey)}
            >
              <IconPlus size="calc(var(--eva-font-size) * .875)" stroke={1.5} />
            </ActionIcon>
          ) : null}
        </div>
        {copy ? (
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={copy.search}
            testid="sidebar-sub-search"
            active
          />
        ) : null}
      </div>
      <div className="eva-sb-scroll">
        <ScrollArea>
          {level === 'assistants' ? (
            <AssistantsList />
          ) : level === 'meetings' ? (
            <MeetingsList query={query} />
          ) : level === 'reviews' ? (
            <ReviewsList />
          ) : level === 'chats' ? (
            <ChatList query={query} footer={footer} />
          ) : level === 'canvas' ? (
            <CanvasList query={query} />
          ) : (
            SETTINGS_SECTIONS.map((s) => {
              const Glyph = SECTION_ICON[s]
              const active = here.page === 'settings' && here.settingsSection === s
              return (
                <button
                  key={s}
                  type="button"
                  className="eva-sb-row"
                  data-testid={`settings-item-${s.toLowerCase()}`}
                  data-active={active ? 'true' : undefined}
                  onClick={(e) => pick(s, e)}
                >
                  <Glyph size={16} aria-hidden />
                  <span className="eva-sb-row-label">{s}</span>
                </button>
              )
            })
          )}
        </ScrollArea>
      </div>
      {level === 'chats' ? (
        <div
          className="eva-sb-subfooter eva-cl-root eva-cl"
          ref={setFooter}
          data-testid="sidebar-sub-footer"
        />
      ) : null}
    </div>
  )
}
