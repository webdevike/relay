import relayIcon from '../assets/brand/relay-icon.png'
import { Tooltip } from '@mantine/core'
import { type MouseEvent } from 'react'
import { placeOf, type Place } from '@evaos/shell-core'
import { useBoards } from '../boards/boards-store'
import { canvasNavPlace } from '../canvas/canvas-store'
import { openFromNav } from '../navigation/open-in-app'
import { navTargetOf } from '../navigation/open-target'
import { NAV_PAGES } from '../pages/page-meta'
import { STARTER_SLUGS, useProfile } from '../pages/profile'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { brandTooltip, useAbout } from '../about/build-info'
import { ScrollArea } from '../ui/ScrollArea'
import { NavRow } from './NavRow'
import { openSub } from './nav-level'
import { countLabel, useSidebarData } from './sidebar-store'

// The built-in Dashboard sits first under Dashboards as Overview (native sidebar::dashboards).
const MAIN = NAV_PAGES.filter((n) => n.slug !== 'setting' && n.slug !== 'dashboard')
const OVERVIEW = NAV_PAGES.find((n) => n.slug === 'dashboard')!
const SETTING = NAV_PAGES.find((n) => n.slug === 'setting')!

export function MainNav() {
  const about = useAbout()
  const here = useTabs(activePlace)
  const jobs = useSidebarData((s) => s.scheduledJobs)
  const error = useSidebarData((s) => s.error)
  const boards = useBoards((s) => s.data?.boards ?? null)
  const profile = useProfile()
  const main = MAIN.filter((n) => profile === 'eva' || STARTER_SLUGS[n.slug])

  const go = (page: Place['page'], e: MouseEvent): void => {
    const here_ = navTargetOf(e) === 'here'
    const nav = (p: Place): void => openFromNav(p, e)
    if (page === 'assistants') {
      nav(placeOf('assistants'))
      openSub('assistants')
    } else if (page === 'chat') {
      // A plain click on Chat while already on a chat only drills in.
      if (!(here.page === 'chat' && here_)) nav(placeOf('chat'))
      openSub('chats')
    } else if (page === 'meetings') {
      nav(placeOf('meetings'))
      openSub('meetings')
    } else if (page === 'reviews') {
      nav(placeOf('reviews'))
      openSub('reviews')
    } else if (page === 'canvas') {
      // A plain click while on a board only drills in.
      if (!(here.page === 'canvas' && here_)) nav(canvasNavPlace())
      openSub('canvas')
    } else if (page === 'settings') {
      nav(placeOf('settings', { settingsSection: 'Theme' }))
      openSub('settings')
    } else {
      nav(placeOf(page))
    }
  }

  return (
    <div className="eva-sb-page" data-testid="sidebar-main">
      <div className="eva-sb-header">
        <Tooltip
          label={brandTooltip(about?.build ?? null, __RELAY_BUILT_AT__)}
          position="bottom-start"
          openDelay={400}
          withinPortal
        >
          <div className="eva-sb-brand">
            <img className="eva-sb-logo" src={relayIcon} alt="" aria-hidden draggable={false} />
            <span className="eva-sb-brand-name">Relay</span>
          </div>
        </Tooltip>
      </div>
      <div className="eva-sb-scroll">
        <ScrollArea data-testid="sidebar-scroll">
          <div className="eva-sb-section eva-sb-section-main">Main</div>
          {main.map((n) => (
            <NavRow
              key={n.slug}
              slug={n.slug}
              title={n.title}
              icon={n.icon}
              active={
                here.page === n.page ||
                (n.slug === 'assistants' && here.page.startsWith('agent:')) ||
                (n.slug === 'reviews' && here.page.startsWith('review:'))
              }
              count={n.slug === 'jobs' && !error ? countLabel(jobs) : null}
              countTestid={n.slug === 'jobs' ? 'count-jobs' : undefined}
              chevron={
                n.slug === 'assistants' ||
                n.slug === 'chat' ||
                n.slug === 'canvas' ||
                n.slug === 'meetings' ||
                n.slug === 'reviews'
              }
              onClick={(e) => go(n.page, e)}
            />
          ))}
          <div className="eva-sb-section eva-sb-section-group" data-testid="sidebar-dashboards">
            Dashboards
          </div>
          <NavRow
            slug={OVERVIEW.slug}
            title="Overview"
            icon={OVERVIEW.icon}
            active={here.page === OVERVIEW.page}
            onClick={(e) => go(OVERVIEW.page, e)}
          />
          {(profile === 'eva' ? boards : null)?.map((b) => (
            <NavRow
              key={b.slug}
              slug={`board-${b.slug}`}
              title={b.title}
              icon={b.icon ?? 'IconLayoutDashboard'}
              active={here.page === `board:${b.slug}`}
              onClick={(e) => go(`board:${b.slug}`, e)}
            />
          ))}
        </ScrollArea>
      </div>
      <div className="eva-sb-footer" data-testid="sidebar-footer">
        {error ? (
          <div className="eva-sb-error eva-dim" data-testid="sidebar-error">
            Could not read counts. Press the refresh shortcut to try again.
          </div>
        ) : null}
        <NavRow
          slug={SETTING.slug}
          title={SETTING.title}
          icon={SETTING.icon}
          active={here.page === 'settings'}
          onClick={(e) => go('settings', e)}
        />
      </div>
    </div>
  )
}
