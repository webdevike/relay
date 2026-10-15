import { Popover, type PopoverProps } from '@mantine/core'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { overlayTransitionDuration } from './motion'
import { useOccludeBrowser } from './overlay-store'
import './overlay.css'

export interface EvaPopoverProps extends Omit<
  PopoverProps,
  'opened' | 'onChange' | 'closeOnEscape'
> {
  opened: boolean
  onChange: (opened: boolean) => void
  testid?: string
}

function EvaPopoverRoot({ opened, onChange, testid, children, ...rest }: EvaPopoverProps) {
  useOccludeBrowser(opened)
  useDismissable(DISMISS_PRIORITY.overlay, () => onChange(false), opened)
  return (
    <Popover
      {...rest}
      opened={opened}
      onChange={onChange}
      withinPortal
      withArrow={false}
      offset={4}
      zIndex={300}
      closeOnEscape={false}
      radius="var(--eva-radius, 6px)"
      transitionProps={{ duration: overlayTransitionDuration() }}
      classNames={{ dropdown: 'eva-popover-dropdown' }}
      data-testid={testid}
    >
      {children}
    </Popover>
  )
}

export const EvaPopover = Object.assign(EvaPopoverRoot, {
  Target: Popover.Target,
  Dropdown: Popover.Dropdown,
})
