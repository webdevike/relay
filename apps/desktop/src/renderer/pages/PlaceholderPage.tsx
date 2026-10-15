import {
  IconBrain,
  IconCalendar,
  IconCalendarTime,
  IconFile,
  IconFlame,
  IconHelp,
  IconInbox,
  IconLayoutDashboard,
  IconListCheck,
  IconMessage,
  IconSettings,
  IconUsers,
  type Icon,
} from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { NAV_PAGES, pageMeta } from './page-meta'
import './pages.css'

const ICONS: Record<string, Icon> = {
  IconBrain,
  IconCalendar,
  IconCalendarTime,
  IconFile,
  IconFlame,
  IconHelp,
  IconInbox,
  IconLayoutDashboard,
  IconListCheck,
  IconMessage,
  IconSettings,
  IconUsers,
}

export function PlaceholderPage({ place }: { place: Place }) {
  const meta = pageMeta(place)
  const nav = NAV_PAGES.find((n) => n.page === place.page)
  const Glyph = ICONS[nav?.icon ?? 'IconFile'] ?? IconFile
  return (
    <div className="eva-page" data-testid={`page-${meta.slug}`}>
      <div className="eva-page-col">
        <div className="eva-page-tile">
          <Glyph size={24} />
        </div>
        <h1 className="eva-page-title">{meta.title}</h1>
        <p className="eva-page-desc">{meta.description}</p>
        {window.__evaosShell?.pageFiller ? (
          <div className="eva-page-filler" data-testid="page-filler" />
        ) : null}
      </div>
    </div>
  )
}
