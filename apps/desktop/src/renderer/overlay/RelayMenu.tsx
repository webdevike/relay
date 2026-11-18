import { Menu, type MenuProps } from '@mantine/core'
import { overlayTransitionDuration } from './motion'

/**
 * Relay's menu as drawn, presentational only (overlay.css styles it): Mantine's Menu with the
 * shell's fixed props, 220px wide unless `width` says otherwise. EvaMenu adds the app's wiring
 * (browser occlusion, Escape through the dismiss stack); the `relay` design system's kit draws
 * this one.
 */
function RelayMenuRoot({ width = 220, children, ...rest }: MenuProps) {
  return (
    <Menu
      {...rest}
      width={width}
      withinPortal
      zIndex={300}
      radius="var(--eva-radius, 6px)"
      transitionProps={{ duration: overlayTransitionDuration() }}
      classNames={{ dropdown: 'eva-menu-dropdown', item: 'eva-menu-item' }}
    >
      {children}
    </Menu>
  )
}

export const RelayMenu = Object.assign(RelayMenuRoot, {
  Target: Menu.Target,
  Dropdown: Menu.Dropdown,
  Item: Menu.Item,
  Label: Menu.Label,
  Divider: Menu.Divider,
  Sub: Menu.Sub,
})
