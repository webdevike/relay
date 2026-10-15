import { Kbd } from '@mantine/core'
import { IconPower, IconSelector, IconSettings, IconUser } from '@tabler/icons-react'
import { useState } from 'react'
import { placeOf } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { EvaMenu } from '../overlay'
import { openSub } from './nav-level'

export function AccountMenu() {
  const [opened, setOpened] = useState(false)
  return (
    <EvaMenu opened={opened} onChange={setOpened} position="top-start" width="target">
      <EvaMenu.Target>
        <button type="button" className="eva-sb-account" data-testid="account-trigger">
          <span className="eva-sb-avatar">
            <IconUser size={16} aria-hidden />
          </span>
          <span className="eva-sb-account-label">Account</span>
          <IconSelector size={16} aria-hidden />
        </button>
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="account-menu">
        <EvaMenu.Item
          data-testid="account-settings"
          leftSection={<IconSettings size={16} stroke={1.5} />}
          onClick={() => {
            openPlace(placeOf('settings', { settingsSection: 'Theme' }))
            openSub('settings')
          }}
        >
          Settings
        </EvaMenu.Item>
        <EvaMenu.Item
          data-testid="account-quit"
          leftSection={<IconPower size={16} stroke={1.5} />}
          rightSection={<Kbd size="xs">⌘Q</Kbd>}
          onClick={() => void invoke('app.quit', {})}
        >
          Quit
        </EvaMenu.Item>
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}
