import type { PageKey, Place } from '@evaos/shell-core'
import { UNTITLED_ROOM } from '@evaos/contract'
import {
  agentTitle,
  boardTitle,
  meetingTitle,
  reviewTitle,
  roomTitle,
  workspaceTitle,
} from '../eva/names-store'
import { reviewFallbackTitle } from '../reviews/review-place'
import { ticketTabTitle } from '../tickets/ticket-place'

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
    slug: 'board',
    page: 'board',
    title: 'Board',
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
  | 'page'
  | 'settings'
  | 'workspace'
  | 'meeting'
  | 'chat'
  | 'canvas'
  | 'agent'
  | 'board'
  | 'review'
  | 'room'
  | 'ticket'

export interface PageMeta {
  kind: PageKind
  slug: string
  title: string
  description: string
}

/** Pages named by a prefix and an id (`workspace:abc`), each read from the id after it. */
const PREFIXED: ReadonlyArray<readonly [string, (id: string) => PageMeta]> = [
  [
    'workspace:',
    (id) => ({
      kind: 'workspace',
      slug: 'workspace',
      title: workspaceTitle(id) ?? id,
      description: 'Workspace activity, todos and journal.',
    }),
  ],
  [
    'agent:',
    (id) => ({ kind: 'agent', slug: 'agent', title: agentTitle(id) ?? id, description: '' }),
  ],
  [
    'board:',
    (id) => ({ kind: 'board', slug: 'board', title: boardTitle(id) ?? id, description: '' }),
  ],
  [
    'review:',
    (id) => ({
      kind: 'review',
      slug: 'review',
      title: reviewTitle(id) ?? reviewFallbackTitle(id),
      description: '',
    }),
  ],
  [
    'ticket:',
    (id) => ({
      kind: 'ticket',
      slug: 'ticket',
      title: ticketTabTitle(`ticket:${id}`),
      description: '',
    }),
  ],
  // Rooms live under Assistants: `rooms` is the New room page, `room:<id>` one room.
  [
    'room:',
    (id) => ({
      kind: 'room',
      slug: 'room',
      title: roomTitle(id) ?? UNTITLED_ROOM,
      description: '',
    }),
  ],
]

/** Text only: callers render these as React children (T-02-38). */
export function pageMeta(place: Place): PageMeta {
  const page = place.page
  const prefixed = PREFIXED.find(([prefix]) => page.startsWith(prefix))
  if (prefixed) return prefixed[1](page.slice(prefixed[0].length))
  if (page === 'rooms') {
    return {
      kind: 'page',
      slug: 'rooms',
      title: 'New room',
      description: 'Assemble who is in it. Nobody starts until you send the first message.',
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
