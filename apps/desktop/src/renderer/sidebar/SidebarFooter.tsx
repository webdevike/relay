import { ActionIcon, Tooltip } from '@mantine/core'
import { IconChartBar, IconSettings } from '@tabler/icons-react'
import { parseAppLink } from '@evaos/chat-core/widget'
import { placeOf, type Place } from '@evaos/shell-core'
import { appLinkPlace } from '../navigation/open-link'
import type { ClickMods } from '../navigation/open-target'
import { UpdateButton } from '../update/UpdateButton'

/** Settings > Usage (`relay://open/settings/usage`); plain Settings until that section exists. */
const USAGE_PLACE: Place =
  appLinkPlace(parseAppLink('relay://open/settings/usage')!) ?? placeOf('settings')

interface Props {
  settingsActive: boolean
  /** Opens a page from the sidebar (same click rules as the rows above). */
  onOpen: (page: Place['page'], e: ClickMods) => void
  onOpenPlace: (place: Place, e: ClickMods) => void
  onSettingsMenu: (x: number, y: number) => void
}

/** One row of small icon buttons under the list: Settings and Usage on the left, update on the right. */
export function SidebarFooter({ settingsActive, onOpen, onOpenPlace, onSettingsMenu }: Props) {
  return (
    <div className="eva-sb-icons" data-testid="sidebar-icons">
      <Tooltip label="Settings" position="top" openDelay={400} withinPortal>
        <ActionIcon
          variant="subtle"
          color="gray"
          className="eva-sb-icon"
          data-testid="nav-setting"
          data-active={settingsActive ? 'true' : undefined}
          aria-label="Settings"
          onClick={(e) => onOpen('settings', e)}
          onContextMenu={(e) => {
            e.preventDefault()
            onSettingsMenu(e.clientX, e.clientY)
          }}
        >
          <IconSettings size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Usage" position="top" openDelay={400} withinPortal>
        <ActionIcon
          variant="subtle"
          color="gray"
          className="eva-sb-icon"
          data-testid="nav-usage"
          aria-label="Usage"
          onClick={(e) => onOpenPlace(USAGE_PLACE, e)}
        >
          <IconChartBar size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
      <span className="eva-sb-icons-gap" />
      <UpdateButton />
    </div>
  )
}
