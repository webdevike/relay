import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import { IconBell, IconChevronLeft, IconMessage, IconPalette, IconPlus } from '@tabler/icons-react'
import { useState, type MouseEvent } from 'react'
import { SETTINGS_SECTIONS, placeOf, type SettingsSection } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { activePlace, newChatTab, useTabs } from '../tabs/tabs-store'
import { ScrollArea } from '../ui/ScrollArea'
import { MeetingsList } from '../meetings/MeetingsList'
import { SearchBox } from './SearchBox'
import { backToRoot, type NavLevel } from './nav-level'

const SECTION_ICON = { Theme: IconPalette, Chat: IconMessage, Notifications: IconBell } as const

const COPY = {
  chats: { title: 'Chats', search: 'Search chats', empty: 'Your chats arrive in a later update.' },
  meetings: { title: 'Meetings', search: 'Search meetings', empty: '' },
} as const

export function SubPage({ level }: { level: Exclude<NavLevel, 'root'> }) {
  const here = useTabs(activePlace)
  const [query, setQuery] = useState('')
  const copy = level === 'settings' ? null : COPY[level]
  const title = copy ? copy.title : 'Settings'

  const pick = (section: SettingsSection, e: MouseEvent): void => {
    openPlace(placeOf('settings', { settingsSection: section }), { newTab: e.metaKey })
  }

  return (
    <div
      className="eva-sb-page"
      data-testid={`sidebar-sub-${level}`}
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
          {level === 'meetings' ? (
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
              size={28}
              aria-label="New chat"
              data-testid="chat-new"
              onClick={newChatTab}
            >
              <IconPlus size={16} />
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
        <ScrollArea fadeBg="var(--eva-chrome)">
          {level === 'meetings' ? (
            <MeetingsList query={query} />
          ) : copy ? (
            <div className="eva-sb-empty eva-dim" data-testid="sidebar-sub-empty">
              {copy.empty}
            </div>
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
    </div>
  )
}
