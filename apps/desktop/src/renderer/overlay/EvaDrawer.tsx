import { Drawer } from '@mantine/core'
import type { ReactNode } from 'react'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { overlayTransitionDuration } from './motion'
import { useOccludeBrowser } from './overlay-store'
import './overlay.css'

export interface EvaDrawerProps {
  opened: boolean
  onClose: () => void
  title?: ReactNode
  size?: number | string
  position?: 'left' | 'right'
  testid?: string
  children?: ReactNode
}

export function EvaDrawer({
  opened,
  onClose,
  title,
  size = 400,
  position = 'right',
  testid,
  children,
}: EvaDrawerProps) {
  useOccludeBrowser(opened)
  useDismissable(DISMISS_PRIORITY.overlay, onClose, opened)
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title={title}
      size={size}
      position={position}
      withinPortal
      zIndex={300}
      closeOnEscape={false}
      radius="var(--eva-radius, 6px)"
      transitionProps={{ duration: overlayTransitionDuration() }}
      classNames={{
        overlay: 'eva-modal-backdrop',
        content: 'eva-modal-content',
        header: 'eva-modal-header',
        title: 'eva-modal-title',
        body: 'eva-modal-body',
      }}
      data-testid={testid}
    >
      {children}
    </Drawer>
  )
}
