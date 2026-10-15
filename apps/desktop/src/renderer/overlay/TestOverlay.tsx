import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import { setTestOverlayOpener } from '../hotkeys/e2e-hooks'
import { EvaModal } from './EvaModal'

export function TestOverlay({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <EvaModal opened={opened} onClose={onClose} title="Test overlay" size={400}>
      <div data-testid="overlay-test">
        <p className="eva-overlay-body">The browser view is hidden while this is open.</p>
        <Button variant="default" onClick={onClose}>
          Close
        </Button>
      </div>
    </EvaModal>
  )
}

/** Wires window.__evaosShell.openTestOverlay (e2e only) to a setter. */
export function useTestOverlayOpener(open: () => void): void {
  const [fn] = useState(() => open)
  useEffect(() => {
    setTestOverlayOpener(fn)
    return () => setTestOverlayOpener(null)
  }, [fn])
}
