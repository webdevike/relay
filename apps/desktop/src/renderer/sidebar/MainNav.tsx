import { useElementSize } from '@mantine/hooks'
import { IconAsterisk } from '@tabler/icons-react'
import { useEffect, useState, type MouseEvent } from 'react'
import { placeOf, type Place } from '@evaos/shell-core'
import { canvasNavPlace } from '../canvas/canvas-store'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { NAV_PAGES } from '../pages/page-meta'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { AppearanceControl } from '../theme/AppearanceControl'
import { ScrollArea } from '../ui/ScrollArea'
import { AccountMenu } from './AccountMenu'
import { NavRow } from './NavRow'
import { RecentList } from './RecentList'
import { SearchBox } from './SearchBox'
import { openSub, useNavLevel } from './nav-level'
import { countLabel, useSidebarData } from './sidebar-store'

const MAIN = NAV_PAGES.filter((n) => n.slug !== 'setting')
const SETTING = NAV_PAGES.find((n) => n.slug === 'setting')!

function EnvBadge() {
  const [live, setLive] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    void invoke('app.info', {}).then((r) => {
      if (!cancelled && r.ok) setLive(r.value.live)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <span className="eva-env-badge" data-testid="env-badge">
      {live === null ? '' : live ? 'Live Eva data' : 'Fixture data'}
    </span>
  )
}

const settingsPlace = (): Place => placeOf('settings', { settingsSection: 'Theme' })

export function MainNav() {
  const here = useTabs(activePlace)
  const level = useNavLevel()
  const jobs = useSidebarData((s) => s.scheduledJobs)
  const error = useSidebarData((s) => s.error)
  const [query, setQuery] = useState('')
  const { ref, width } = useElementSize<HTMLDivElement>()

  const go = (page: Place['page'], e: MouseEvent): void => {
    const newTab = e.metaKey
    if (page === 'assistants') {
      openPlace(placeOf('assistants'), { newTab })
      openSub('assistants')
    } else if (page === 'chat') {
      // A plain click on Chat while already on a chat only drills in.
      if (!(here.page === 'chat' && !newTab)) openPlace(placeOf('chat'), { newTab })
      openSub('chats')
    } else if (page === 'meetings') {
      openPlace(placeOf('meetings'), { newTab })
      openSub('meetings')
    } else if (page === 'canvas') {
      // A plain click while on a board only drills in.
      if (!(here.page === 'canvas' && !newTab)) openPlace(canvasNavPlace(), { newTab })
      openSub('canvas')
    } else if (page === 'settings') {
      openPlace(settingsPlace(), { newTab })
      openSub('settings')
    } else {
      openPlace(placeOf(page), { newTab })
    }
  }

  return (
    <div className="eva-sb-page" ref={ref} data-testid="sidebar-main">
      <div className="eva-sb-header">
        <div className="eva-sb-brand">
          <span className="eva-sb-tile">
            <IconAsterisk size={20} aria-hidden />
          </span>
          <span className="eva-sb-brand-text">
            <span className="eva-sb-brand-name">Relay</span>
            <span className="eva-sb-brand-sub eva-dim">Work OS</span>
          </span>
        </div>
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Search"
          testid="sidebar-search"
          active={level === 'root'}
        />
      </div>
      <div className="eva-sb-scroll">
        <ScrollArea data-testid="sidebar-scroll">
          <div className="eva-sb-section eva-sb-section-main">Main</div>
          {MAIN.map((n) => (
            <NavRow
              key={n.slug}
              slug={n.slug}
              title={n.title}
              icon={n.icon}
              active={
                here.page === n.page || (n.slug === 'assistants' && here.page.startsWith('agent:'))
              }
              count={n.slug === 'jobs' && !error ? countLabel(jobs) : null}
              countTestid={n.slug === 'jobs' ? 'count-jobs' : undefined}
              chevron={
                n.slug === 'assistants' ||
                n.slug === 'chat' ||
                n.slug === 'canvas' ||
                n.slug === 'meetings'
              }
              onClick={(e) => go(n.page, e)}
            />
          ))}
          <div className="eva-sb-divider" />
          <RecentList query={query} />
        </ScrollArea>
      </div>
      <div className="eva-sb-footer" data-testid="sidebar-footer">
        {error ? (
          <div className="eva-sb-error eva-dim" data-testid="sidebar-error">
            Could not read counts or recent items. Press the refresh shortcut to try again.
          </div>
        ) : null}
        <NavRow
          slug={SETTING.slug}
          title={SETTING.title}
          icon={SETTING.icon}
          active={here.page === 'settings'}
          onClick={(e) => go('settings', e)}
        />
        <AccountMenu />
        <AppearanceControl iconOnly={width > 0 && width < 248} />
        <EnvBadge />
      </div>
    </div>
  )
}
