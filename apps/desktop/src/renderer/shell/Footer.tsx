import { useEffect, useState } from 'react'
import { UsageMeter } from '../usage/UsageMeter'

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

/**
 * Which copy of Relay this is: the hot-reloading dev server, a packaged build run from the
 * checkout's `release/` folder, or the installed app. Read from where the renderer loaded.
 */
const BUILD_KIND = import.meta.env.DEV
  ? 'dev build (hot reload)'
  : decodeURIComponent(location.pathname).includes('/release/')
    ? 'test build (release folder)'
    : 'installed app'

/** Full-width strip under the sidebar, main card and panel (native EvaOS footer). */
export function Footer() {
  const needsRestart = useNeedsRestart()
  return (
    <footer className="eva-footer" data-testid="footer">
      {/* Which copy this is and when it started, plus a flag once it needs a restart. */}
      <span className="eva-build-stamp" data-testid="build-kind">
        {BUILD_KIND} · {__RELAY_BUILD__}
        {needsRestart ? (
          <span className="eva-build-stale" title="App code changed; restart the dev build to load it">
            {' · needs rebuild'}
          </span>
        ) : null}
      </span>
      <UsageMeter />
    </footer>
  )
}
