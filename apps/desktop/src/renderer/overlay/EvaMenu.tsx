import { Menu, type MenuProps } from '@mantine/core'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { overlayTransitionDuration } from './motion'
import { useOccludeBrowser } from './overlay-store'
import './overlay.css'

export interface EvaMenuProps extends Omit<MenuProps, 'opened' | 'onChange' | 'closeOnEscape'> {
  opened: boolean
  onChange: (opened: boolean) => void
  testid?: string
}

function EvaMenuRoot({ opened, onChange, testid, width = 220, children, ...rest }: EvaMenuProps) {
  useOccludeBrowser(opened)
  useDismissable(DISMISS_PRIORITY.overlay, () => onChange(false), opened)
  return (
    <Menu
      {...rest}
      opened={opened}
      onChange={onChange}
      width={width}
      withinPortal
      zIndex={300}
      closeOnEscape={false}
      radius="var(--eva-radius, 6px)"
      transitionProps={{ duration: overlayTransitionDuration() }}
      classNames={{ dropdown: 'eva-menu-dropdown', item: 'eva-menu-item' }}
      data-testid={testid}
    >
      {children}
    </Menu>
  )
}

export const EvaMenu = Object.assign(EvaMenuRoot, {
  Target: Menu.Target,
  Dropdown: Menu.Dropdown,
  Item: Menu.Item,
  Label: Menu.Label,
  Divider: Menu.Divider,
})
