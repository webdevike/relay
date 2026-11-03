import { useEffect, useRef, useState } from 'react'
import { DISMISS_PRIORITY, useDismissable } from '../hotkeys/dismiss'
import { useEntrance } from '../theme/motion'
import { MainNav } from './MainNav'
import { SubPage } from './SubPages'
import { backToRoot, useNavLevel, type NavLevel } from './nav-level'
import './sidebar.css'

const motionOff = (): boolean => document.documentElement.dataset['evaMotion'] === 'off'

export function SidebarColumn() {
  const level = useNavLevel()
  const entrance = useEntrance()
  const [settled, setSettled] = useState<NavLevel>('root')
  const lastSub = useRef<Exclude<NavLevel, 'root'> | null>(null)
  if (level !== 'root') lastSub.current = level

  // Esc pops the sub-page at the lowest band (D-12).
  useDismissable(DISMISS_PRIORITY.subPageBack, backToRoot, level !== 'root')

  useEffect(() => {
    if (motionOff()) {
      setSettled(level)
      return
    }
    // transitionend is the primary signal; the timer covers a transition that never fires.
    const t = setTimeout(() => setSettled(level), 320)
    return () => clearTimeout(t)
  }, [level])

  const sub = level !== 'root' ? level : settled !== 'root' ? lastSub.current : null
  const rootAway = level !== 'root' && settled !== 'root'
  const subAway = level === 'root' && settled === 'root'

  return (
    <aside
      className={`eva-sidebar${entrance ? ' eva-cue-sidebar' : ''}`}
      data-testid="sidebar"
      data-sidebar-level={level}
    >
      <div className="eva-sidebar-inner" data-testid="rail">
        <div
          className="eva-sb-track"
          data-level={level}
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget) setSettled(level)
          }}
        >
          <div className="eva-sb-slot" data-away={rootAway ? 'true' : undefined} inert={rootAway}>
            <nav aria-label="Main" className="eva-sb-nav">
              <MainNav />
            </nav>
          </div>
          <div className="eva-sb-slot" data-away={subAway ? 'true' : undefined} inert={subAway}>
            {sub ? <SubPage level={sub} /> : null}
          </div>
        </div>
      </div>
    </aside>
  )
}
