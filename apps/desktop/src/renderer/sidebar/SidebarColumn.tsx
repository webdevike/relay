import { useEffect, useState } from 'react'
import { invoke } from '../ipc'

/** Placeholder owned by 02-08; 02-10 replaces the body with the real sidebar. */
export function SidebarColumn() {
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
    <aside className="eva-sidebar" data-testid="sidebar" data-sidebar-level="root">
      <div className="eva-sidebar-inner" data-testid="rail">
        <nav aria-label="Main" className="eva-sidebar-nav">
          <h1 className="eva-wordmark">EvaOS</h1>
          <div className="eva-label eva-dim">Chats and tools arrive in a later update.</div>
        </nav>
        <div className="eva-sidebar-foot">
          <span className="eva-env-badge" data-testid="env-badge">
            {live === null ? '' : live ? 'Live Eva data' : 'Fixture data'}
          </span>
        </div>
      </div>
    </aside>
  )
}
