import { Box, Divider, Kbd } from '@mantine/core'
import { IconPower, IconSettings, IconUser } from '@tabler/icons-react'
import { useState } from 'react'
import { placeOf } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { EvaPopover } from '../overlay'
import { AppearanceControl } from '../theme/AppearanceControl'
import { NavRow } from './NavRow'
import { openSub } from './nav-level'

export interface SettingsPopoverProps {
  slug: string
  title: string
  icon: string
  active: boolean
}

/** The footer's one row. It opens account, appearance and the way into the Settings page. */
export function SettingsPopover({ slug, title, icon, active }: SettingsPopoverProps) {
  const [opened, setOpened] = useState(false)
  return (
    <EvaPopover
      opened={opened}
      onChange={setOpened}
      position="top-start"
      width="target"
      testid="settings-popover"
    >
      <EvaPopover.Target>
        <div>
          <NavRow
            slug={slug}
            title={title}
            icon={icon}
            active={active}
            onClick={() => setOpened((o) => !o)}
          />
        </div>
      </EvaPopover.Target>
      <EvaPopover.Dropdown data-testid="settings-menu">
        <div className="eva-sb-row eva-sb-row-static eva-dim" data-testid="account-row">
          <IconUser size={16} stroke={1.5} aria-hidden />
          <span className="eva-sb-row-label">Account</span>
        </div>
        <button
          type="button"
          className="eva-sb-row"
          data-testid="account-quit"
          onClick={() => {
            setOpened(false)
            void invoke('app.quit', {})
          }}
        >
          <IconPower size={16} stroke={1.5} aria-hidden />
          <span className="eva-sb-row-label">Quit</span>
          <Kbd size="xs">⌘Q</Kbd>
        </button>
        <Divider my="xs" color="var(--eva-border)" />
        <Box px="xs">
          <AppearanceControl size="xs" />
        </Box>
        <Divider my="xs" color="var(--eva-border)" />
        <button
          type="button"
          className="eva-sb-row"
          data-testid="settings-all"
          onClick={() => {
            setOpened(false)
            openPlace(placeOf('settings', { settingsSection: 'Theme' }))
            openSub('settings')
          }}
        >
          <IconSettings size={16} stroke={1.5} aria-hidden />
          <span className="eva-sb-row-label">All settings</span>
        </button>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
