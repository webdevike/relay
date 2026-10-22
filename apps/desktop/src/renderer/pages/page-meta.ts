import type { PageKey, Place } from '@evaos/shell-core'
import { meetingTitle, workspaceTitle } from '../eva/names-store'

export interface NavPage {
  slug: string
  page: PageKey
  title: string
  description: string
  icon: string
}

/** The single copy table for nav pages (D-09, UI-SPEC Copywriting). Sidebar and pages share it. */
export const NAV_PAGES: readonly NavPage[] = [
  {
    slug: 'dashboard',
    page: 'dashboard',
    title: 'Dashboard',
    description: 'Your workspaces, activity and open todos.',
    icon: 'IconLayoutDashboard',
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
    description: 'Scheduled jobs and their runs.',
    icon: 'IconCalendarTime',
  },
  {
    slug: 'habits',
    page: 'habits',
    title: 'Habits',
    description: 'Your habits and streaks.',
    icon: 'IconFlame',
  },
  {
    slug: 'meetings',
    page: 'meetings',
    title: 'Meetings',
    description: 'Meetings and their notes.',
    icon: 'IconUsers',
  },
  { slug: 'setting', page: 'settings', title: 'Setting', description: '', icon: 'IconSettings' },
]

export type PageKind = 'page' | 'settings' | 'workspace' | 'meeting' | 'chat'

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
      description: 'Workspace activity, todos and journal.',
    }
  }
  if (page === 'meetings' && place.meeting !== null) {
    return {
      kind: 'meeting',
      slug: 'meeting',
      title: meetingTitle(place.meeting) ?? place.meeting,
      description: 'Meeting transcript, notes and actions.',
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
