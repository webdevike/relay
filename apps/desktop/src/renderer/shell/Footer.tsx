import { useEffect, useState } from 'react'
import type { AppInfo } from '@evaos/contract'
import { invoke } from '../ipc'
import { UsageMeter } from '../usage/UsageMeter'
import { restartForUpdate, useUpdate } from '../update/update-store'

/** True once the dev server reports a main/preload edit that HMR cannot apply. Never in packaged builds. */
function useNeedsRestart(): boolean {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    const hot = import.meta.hot
    if (!hot) return
    const onStale = () => setStale(true)
    hot.on('relay:stale', onStale)
    return () => hot.off('relay:stale', onStale)
  }, [])
  return stale
}

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    let cancelled = false
    void invoke('app.info', {}).then((r) => {
      if (!cancelled && r.ok) setInfo(r.value)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return info
}

/**
 * How a Relay Dev copy loaded: the hot-reloading dev server, a packaged build in the checkout's
 * `release/` folder, or the built files in `out/`. Read from where the renderer loaded.
 */
const BUILD_KIND = import.meta.env.DEV
  ? 'hot reload'
  : decodeURIComponent(location.pathname).includes('/release/')
    ? 'release folder'
    : 'built files'

/** Full-width strip under the sidebar, main card and panel (native EvaOS footer). */
export function Footer() {
  const needsRestart = useNeedsRestart()
  const info = useAppInfo()
  const updateChip = useUpdate((s) => s.update.pending && s.dismissed)
  return (
    <footer className="eva-footer" data-testid="footer">
      {/* Dev copies say which copy they are; the installed app shows nothing. */}
      {info && info.instance !== 'stable' ? (
        <span className="eva-build-stamp" data-testid="build-kind">
          {info.instance === 'dev' ? (
            <span
              className="eva-dev-badge"
              data-testid="dev-badge"
              title={`Relay Dev · config ${info.configDir}`}
            >
              DEV
            </span>
          ) : null}
          {`${BUILD_KIND} · ${__RELAY_BUILD__}`}
          {needsRestart ? (
            <span
              className="eva-build-stale"
              title="App code changed; restart the dev build to load it"
            >
              {' · needs rebuild'}
            </span>
          ) : null}
        </span>
      ) : null}
      {updateChip ? (
        <button
          type="button"
          className="eva-update-chip"
          data-testid="update-chip"
          onMouseDown={(e) => e.preventDefault()}
          onClick={restartForUpdate}
        >
          Update ready · Restart
        </button>
      ) : null}
      <UsageMeter />
    </footer>
  )
}
