import type { PageKey, Place } from '@evaos/shell-core'
import {
  agentTitle,
  boardTitle,
  meetingTitle,
  reviewTitle,
  workspaceTitle,
} from '../eva/names-store'
import { reviewFallbackTitle } from '../reviews/review-place'

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
    icon: 'IconMessageChatbot',
  },
  {
    slug: 'agents',
    page: 'agents',
    title: 'Agents',
    description: 'Every task your agents work on, by status.',
    icon: 'IconLayoutKanban',
  },
  {
    slug: 'dashboard',
    page: 'dashboard',
    title: 'Dashboard',
    description: 'Your workspaces, activity and open todos.',
    icon: 'IconLayoutDashboard',
  },
  { slug: 'chat', page: 'chat', title: 'Chat', description: '', icon: 'IconMessage' },
  {
    slug: 'skills',
    page: 'skills',
    title: 'Skills',
    description: 'The skills your assistants load: read and edit them in place.',
    icon: 'IconSparkles',
  },
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
    slug: 'feed',
    page: 'feed',
    title: 'Feed',
    description: 'New tools, platforms and designs, ranked to your taste.',
    icon: 'IconCompass',
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
  'page' | 'settings' | 'workspace' | 'meeting' | 'chat' | 'canvas' | 'agent' | 'board' | 'review'

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
  if (page.startsWith('review:')) {
    const id = page.slice('review:'.length)
    return {
      kind: 'review',
      slug: 'review',
      title: reviewTitle(id) ?? reviewFallbackTitle(id),
      description: '',
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
  if (page === 'setup') return { kind: 'page', slug: 'setup', title: 'Setup', description: '' }
  const nav = NAV_PAGES.find((n) => n.page === page)
  return {
    kind: page === 'chat' ? 'chat' : page === 'canvas' ? 'canvas' : 'page',
    slug: nav?.slug ?? page,
    title: nav?.title ?? page,
    description: nav?.description ?? '',
  }
}
