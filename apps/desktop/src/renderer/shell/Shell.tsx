import './shell.css'
import { useLayoutEffect, useState } from 'react'
import { ChatPane } from '../chat/ChatPane'
import { TestOverlay, useTestOverlayOpener } from '../overlay/TestOverlay'
import { SidebarColumn } from '../sidebar/SidebarColumn'
import { Footer } from './Footer'
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
    const write = (): void => {
      if (!root) return
      const s = layoutStore.getState()
      root.style.setProperty('--eva-sidebar-w', `${s.sidebarPx}px`)
      root.style.setProperty('--eva-panel-w', `${s.panelPx}px`)
      root.style.setProperty('--eva-main-left', s.sidebarPx > 0 ? '0px' : '8px')
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
          {/* 02-09 puts the tab strip and page router in this slot. */}
          <ChatPane />
        </section>
        <PanelCard />
      </div>
      <Footer />
      <TestOverlay opened={overlayOpen} onClose={() => setOverlayOpen(false)} />
    </div>
  )
}
