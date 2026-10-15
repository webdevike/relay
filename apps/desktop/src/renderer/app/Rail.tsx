import { useEffect, useState } from 'react'
import { Button } from '@mantine/core'
import { invoke } from '../ipc'

export function Rail({ onOpenTestOverlay }: { onOpenTestOverlay?: () => void } = {}) {
  const [live, setLive] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void invoke('app.info', {}).then((res) => {
      if (!cancelled && res.ok) setLive(res.value.live)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <aside className="eva-rail" data-testid="rail">
      <div className="eva-rail-traffic" />
      <div className="eva-rail-body">
        <h1 className="eva-wordmark">EvaOS</h1>
        <div className="eva-label eva-dim">Chats and tools arrive in a later update.</div>
      </div>
      {onOpenTestOverlay ? (
        <Button
          variant="subtle"
          className="eva-rail-test"
          data-testid="overlay-open"
          onClick={onOpenTestOverlay}
        >
          Test overlay
        </Button>
      ) : null}
      <div className="eva-rail-foot">
        <span className="eva-env-badge" data-testid="env-badge">
          {live === null ? '' : live ? 'Live Eva data' : 'Fixture data'}
        </span>
      </div>
    </aside>
  )
}
