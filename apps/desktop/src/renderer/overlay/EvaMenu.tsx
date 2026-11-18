import type { MenuProps } from '@mantine/core'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { useOccludeBrowser } from './overlay-store'
import { RelayMenu } from './RelayMenu'
import './overlay.css'

export interface EvaMenuProps extends Omit<MenuProps, 'opened' | 'onChange' | 'closeOnEscape'> {
  opened: boolean
  onChange: (opened: boolean) => void
  testid?: string
}

function EvaMenuRoot({ opened, onChange, testid, children, ...rest }: EvaMenuProps) {
  useOccludeBrowser(opened)
  useDismissable(DISMISS_PRIORITY.overlay, () => onChange(false), opened)
  return (
    <RelayMenu
      {...rest}
      opened={opened}
      onChange={onChange}
      closeOnEscape={false}
      data-testid={testid}
    >
      {children}
    </RelayMenu>
  )
}

export const EvaMenu = Object.assign(EvaMenuRoot, {
  Target: RelayMenu.Target,
  Dropdown: RelayMenu.Dropdown,
  Item: RelayMenu.Item,
  Label: RelayMenu.Label,
  Divider: RelayMenu.Divider,
  Sub: RelayMenu.Sub,
})
