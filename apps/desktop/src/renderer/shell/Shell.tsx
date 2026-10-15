import './shell.css'
import { useLayoutEffect, useState } from 'react'
import { GAP } from '@evaos/shell-core'
import { TestOverlay, useTestOverlayOpener } from '../overlay/TestOverlay'
import { SidebarColumn } from '../sidebar/SidebarColumn'
import { Footer } from './Footer'
import { MainCard } from './MainCard'
import { Grip } from './Grip'
import { PanelCard } from './PanelCard'
import { layoutStore, setWindowWidth, useLayout } from './layout-store'

export function Shell() {
  const state = useLayout((s) => s.state)
  const [overlayOpen, setOverlayOpen] = useState(false)
  useTestOverlayOpener(() => setOverlayOpen(true))

  // Widths go to CSS variables imperatively, never through React state per frame (Pitfall 8).
  useLayoutEffect(() => {
    const root = document.querySelector<HTMLElement>('[data-testid=shell]')
    let lastFitted = layoutStore.getState().sidebarWidth
    let previous = layoutStore.getState()
    const write = (): void => {
      if (!root) return
      const s = layoutStore.getState()
      // Native animates manual sidebar toggles only, including the panel's refit.
      // Window fitting, panel toggles and live resize must stay under the pointer.
      root.dataset['sidebarTransition'] = String(
        s.sidebarWanted !== previous.sidebarWanted &&
          s.windowWidth === previous.windowWidth &&
          s.panelOpen === previous.panelOpen,
      )
      previous = s
      if (s.sidebarPx > 0) lastFitted = s.sidebarPx
      // Sidebar content keeps its width while the column folds or hides (D-17).
      root.style.setProperty('--eva-sidebar-inner-w', `${Math.max(lastFitted - GAP, 0)}px`)
      root.style.setProperty('--eva-sidebar-w', `${s.sidebarPx}px`)
      root.style.setProperty('--eva-panel-w', `${s.panelPx}px`)
      root.style.setProperty('--eva-main-left', s.sidebarPx > 0 ? '0px' : `${GAP}px`)
    }
    setWindowWidth(window.innerWidth)
    write()
    const off = layoutStore.subscribe(write)
    let frame = 0
    const onResize = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setWindowWidth(window.innerWidth)
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      off()
      window.removeEventListener('resize', onResize)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div className="eva-shell" data-testid="shell" data-sidebar-state={state}>
      <div className="eva-shell-body">
        <SidebarColumn />
        {state === 'open' ? <Grip edge="sidebar" /> : null}
        <section className="eva-card eva-main-card" data-testid="main-card">
          <MainCard />
        </section>
        <PanelCard />
      </div>
      <Footer />
      <TestOverlay opened={overlayOpen} onClose={() => setOverlayOpen(false)} />
    </div>
  )
}
