import { CloseButton, Modal } from '@mantine/core'
import type { ReactNode } from 'react'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { overlayTransitionDuration } from './motion'
import { useOccludeBrowser } from './overlay-store'
import './overlay.css'

export interface EvaModalProps {
  opened: boolean
  onClose: () => void
  title?: ReactNode
  size?: number | string
  testid?: string
  children?: ReactNode
}

export function EvaModal({ opened, onClose, title, size = 400, testid, children }: EvaModalProps) {
  useOccludeBrowser(opened)
  useDismissable(DISMISS_PRIORITY.overlay, onClose, opened)
  return (
    <Modal.Root
      opened={opened}
      onClose={onClose}
      size={size}
      centered
      withinPortal
      zIndex={300}
      closeOnEscape={false}
      radius="var(--eva-radius, 6px)"
      transitionProps={{ duration: overlayTransitionDuration() }}
      data-testid={testid}
    >
      <Modal.Overlay className="eva-modal-backdrop" />
      <Modal.Content className="eva-modal-content">
        <Modal.Header className="eva-modal-header">
          <Modal.Title className="eva-modal-title">{title}</Modal.Title>
          <CloseButton size={28} aria-label="Close" onClick={onClose} />
        </Modal.Header>
        <Modal.Body className="eva-modal-body">{children}</Modal.Body>
      </Modal.Content>
    </Modal.Root>
  )
}
