import type { PageKey, Place } from '@evaos/shell-core'
import { agentTitle, boardTitle, meetingTitle, workspaceTitle } from '../eva/names-store'

export interface NavPage {
  slug: string
  page: PageKey
  title: string
  description: string
  icon: string
}

/** The single copy table for nav pages (D-09, UI-SPEC Copywriting). Sidebar and pages share it. */
export const NAV_PAGES: readonly NavPage[] = [
  // First, like native's sidebar.
  {
    slug: 'assistants',
    page: 'assistants',
    title: 'Assistants',
    description:
      'Always-on agents, each with its own thread. Open one to pick up where it left off.',
    icon: 'IconRobot',
  },
  {
    slug: 'dashboard',
    page: 'dashboard',
    title: 'Dashboard',
    description: 'Your workspaces, activity and open todos.',
    icon: 'IconLayoutDashboard',
  },
  { slug: 'chat', page: 'chat', title: 'Chat', description: '', icon: 'IconMessage' },
  { slug: 'canvas', page: 'canvas', title: 'Canvas', description: '', icon: 'IconSchema' },
  {
    slug: 'rooms',
    page: 'rooms',
    title: 'Rooms',
    description: 'Several agents talk a question through and pin the decision.',
    icon: 'IconUsersGroup',
  },
  {
    slug: 'studio',
    page: 'studio',
    title: 'Studio',
    description: 'Make images and videos on the Relay host, then remix them.',
    icon: 'IconPhotoSpark',
  },
  {
    slug: 'reviews',
    page: 'reviews',
    title: 'Reviews',
    description: 'Pull requests waiting on your review, with a guided walkthrough.',
    icon: 'IconInbox',
  },
  {
    slug: 'test-bench',
    page: 'test-bench',
    title: 'Test Bench',
    description: "Eva's experiments: every run, its tests and their measurements.",
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

export type PageKind =
  'page' | 'settings' | 'workspace' | 'meeting' | 'chat' | 'canvas' | 'agent' | 'board'

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
  if (page.startsWith('agent:')) {
    const id = page.slice('agent:'.length)
    return { kind: 'agent', slug: 'agent', title: agentTitle(id) ?? id, description: '' }
  }
  if (page.startsWith('board:')) {
    const slug = page.slice('board:'.length)
    return { kind: 'board', slug: 'board', title: boardTitle(slug) ?? slug, description: '' }
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
    kind: page === 'chat' ? 'chat' : page === 'canvas' ? 'canvas' : 'page',
    slug: nav?.slug ?? page,
    title: nav?.title ?? page,
    description: nav?.description ?? '',
  }
}
