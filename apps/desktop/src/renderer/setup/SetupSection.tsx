import { Button } from '@mantine/core'
import { useEffect, useState } from 'react'
import { placeOf } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { MemorySection } from './steps-memory'

/** True once main says this app runs the starter profile (the wizard's audience), not Eva's. */
export function useStarterProfile(): boolean {
  const [starter, setStarter] = useState(false)
  useEffect(() => {
    let cancelled = false
    void invoke('app.info', {}).then((r) => {
      if (!cancelled && r.ok) setStarter(r.value.profile === 'starter')
    })
    return () => {
      cancelled = true
    }
  }, [])
  return starter
}

/** Settings, Setup: run the checks again. It never deletes anything. */
export function SetupSection() {
  const [root, setRoot] = useState('')
  useEffect(() => {
    let cancelled = false
    void invoke('app.info', {}).then((r) => {
      if (!cancelled && r.ok && r.value.profile === 'starter') setRoot(r.value.homeRoot)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <>
      <div className="eva-settings-card">
        <div className="eva-settings-row eva-settings-row-static" data-testid="settings-setup-row">
          <span className="eva-settings-label">
            <span className="eva-settings-label-title">Run setup again</span>
            <span className="eva-settings-label-help">
              Checks your tools, AI sign-in and Relay Host again, and fixes what is missing. Step
              through to the iPhone step to set up Tailscale and pairing later. Nothing is deleted
              or replaced.
            </span>
          </span>
          <Button
            variant="default"
            onClick={() => openPlace(placeOf('setup'))}
            data-testid="setup-rerun"
          >
            Run setup again
          </Button>
        </div>
      </div>
      {root !== '' ? <MemorySection root={root} /> : null}
    </>
  )
}
