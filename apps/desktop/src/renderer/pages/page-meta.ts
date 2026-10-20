import type { Place } from '@evaos/shell-core'
import { meetingTitle, workspaceTitle } from '../eva/names-store'

export interface NavPage {
  slug: string
  page: string
  title: string
  description: string
  icon: string
}

const later = (what: string): string => `${what} will appear here in a later update.`

/** The single copy table for nav pages (D-09, UI-SPEC Copywriting). Sidebar and pages share it. */
export const NAV_PAGES: readonly NavPage[] = [
  {
    slug: 'dashboard',
    page: 'dashboard',
    title: 'Dashboard',
    description: later('Your workspaces, activity and open todos'),
    icon: 'IconLayoutDashboard',
  },
  {
    slug: 'inbox',
    page: 'inbox',
    title: 'Inbox',
    description: later('Digests and approvals from Eva'),
    icon: 'IconInbox',
  },
  { slug: 'chat', page: 'chat', title: 'Chat', description: '', icon: 'IconMessage' },
  {
    slug: 'test-bench',
    page: 'test-bench',
    title: 'Test Bench',
    description: 'Compare UI/UX verification against captured evidence.',
    icon: 'IconListCheck',
  },
  {
    slug: 'jobs',
    page: 'jobs',
    title: 'Jobs',
    description: later('Scheduled jobs and their runs'),
    icon: 'IconCalendarTime',
  },
  {
    slug: 'habits',
    page: 'habits',
    title: 'Habits',
    description: later('Your habits and streaks'),
    icon: 'IconFlame',
  },
  {
    slug: 'meetings',
    page: 'meetings',
    title: 'Meetings',
    description: later('Meetings and their notes'),
    icon: 'IconUsers',
  },
  {
    slug: 'calendar',
    page: 'calendar',
    title: 'Calendar',
    description: later('Your calendar'),
    icon: 'IconCalendar',
  },
  {
    slug: 'tasks',
    page: 'tasks',
    title: 'Tasks',
    description: later('Your open todos'),
    icon: 'IconListCheck',
  },
  {
    slug: 'memory',
    page: 'memory',
    title: 'Memory',
    description: later("Eva's memory"),
    icon: 'IconBrain',
  },
  {
    slug: 'files',
    page: 'files',
    title: 'Files',
    description: 'Browse and edit files from here in a later update.',
    icon: 'IconFile',
  },
  { slug: 'setting', page: 'settings', title: 'Setting', description: '', icon: 'IconSettings' },
  {
    slug: 'help',
    page: 'help',
    title: 'Help Center',
    description: later('Guides and shortcuts'),
    icon: 'IconHelp',
  },
]

export type PageKind = 'page' | 'settings' | 'workspace' | 'board' | 'meeting' | 'chat'

export interface PageMeta {
  kind: PageKind
  slug: string
  title: string
  description: string
}

/** Text only: callers render these as React children (T-02-38). */
export function pageMeta(place: Place): PageMeta {
  const page = place.page
  if (page.startsWith('workspace:')) {
    const id = page.slice('workspace:'.length)
    return {
      kind: 'workspace',
      slug: 'workspace',
      title: workspaceTitle(id) ?? id,
      description: later('This workspace'),
    }
  }
  if (page.startsWith('board:')) {
    const slug = page.slice('board:'.length)
    return { kind: 'board', slug: 'board', title: slug, description: later('This board') }
  }
  if (page === 'meetings' && place.meeting !== null) {
    return {
      kind: 'meeting',
      slug: 'meeting',
      title: meetingTitle(place.meeting) ?? place.meeting,
      description: later('This meeting and its notes'),
    }
  }
  if (page === 'settings') {
    return { kind: 'settings', slug: 'settings', title: place.settingsSection, description: '' }
  }
  const nav = NAV_PAGES.find((n) => n.page === page)
  return {
    kind: page === 'chat' ? 'chat' : 'page',
    slug: nav?.slug ?? page,
    title: nav?.title ?? page,
    description: nav?.description ?? '',
  }
}
