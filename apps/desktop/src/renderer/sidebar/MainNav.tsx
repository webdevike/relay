import { useElementSize } from '@mantine/hooks'
import { IconAsterisk } from '@tabler/icons-react'
import { useEffect, useState, type MouseEvent } from 'react'
import { placeOf, type Place } from '@evaos/shell-core'
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

const MAIN = NAV_PAGES.filter((n) => n.slug !== 'setting' && n.slug !== 'help')
const SETTING = NAV_PAGES.find((n) => n.slug === 'setting')!
const HELP = NAV_PAGES.find((n) => n.slug === 'help')!

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
  const todos = useSidebarData((s) => s.openTodos)
  const jobs = useSidebarData((s) => s.scheduledJobs)
  const error = useSidebarData((s) => s.error)
  const [query, setQuery] = useState('')
  const { ref, width } = useElementSize<HTMLDivElement>()

  const go = (page: string, e: MouseEvent): void => {
    const newTab = e.metaKey
    if (page === 'chat') {
      // A plain click on Chat while already on a chat only drills in.
      if (!(here.page === 'chat' && !newTab)) openPlace(placeOf('chat'), { newTab })
      openSub('chats')
    } else if (page === 'meetings') {
      openPlace(placeOf('meetings'), { newTab })
      openSub('meetings')
    } else if (page === 'settings') {
      openPlace(settingsPlace(), { newTab })
      openSub('settings')
    } else {
      openPlace(placeOf(page as never), { newTab })
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
            <span className="eva-sb-brand-name">EvaOS</span>
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
        <ScrollArea data-testid="sidebar-scroll" fadeBg="var(--eva-chrome)">
          <div className="eva-sb-section eva-sb-section-main">Main</div>
          {MAIN.map((n) => (
            <NavRow
              key={n.slug}
              slug={n.slug}
              title={n.title}
              icon={n.icon}
              active={here.page === n.page}
              count={
                n.slug === 'tasks' && !error
                  ? countLabel(todos)
                  : n.slug === 'jobs' && !error
                    ? countLabel(jobs)
                    : null
              }
              countTestid={
                n.slug === 'tasks' ? 'count-tasks' : n.slug === 'jobs' ? 'count-jobs' : undefined
              }
              chevron={n.slug === 'chat' || n.slug === 'meetings'}
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
        <NavRow
          slug={HELP.slug}
          title={HELP.title}
          icon={HELP.icon}
          active={here.page === 'help'}
          onClick={(e) => go('help', e)}
        />
        <AccountMenu />
        <AppearanceControl iconOnly={width > 0 && width < 248} />
        <EnvBadge />
      </div>
    </div>
  )
}
