import type { Place } from '@evaos/shell-core'
import { UNTITLED_ROOM } from '@evaos/contract'
import {
  agentTitle,
  boardTitle,
  canvasTitle,
  chatTitle,
  meetingTitle,
  reviewTitle,
  roomTitle,
  workspaceTitle,
} from '../eva/names-store'
import { reviewFallbackTitle, reviewIconOf } from '../reviews/review-place'
import { ticketTabTitle } from '../tickets/ticket-place'

const TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  assistants: 'Assistants',
  agents: 'Agents',
  board: 'Board',
  chat: 'Chat',
  skills: 'Skills',
  'test-bench': 'Test Bench',
  jobs: 'Jobs',
  habits: 'Habits',
  meetings: 'Meetings',
  canvas: 'Canvas',
  rooms: 'New room',
  studio: 'Studio',
  feed: 'Feed',
  reviews: 'Reviews',
  settings: 'Settings',
  setup: 'Setup',
}

const ICONS: Record<string, string> = {
  dashboard: 'IconLayoutDashboard',
  assistants: 'IconMessageChatbot',
  agents: 'IconRobot',
  board: 'IconLayoutKanban',
  chat: 'IconMessage',
  skills: 'IconSparkles',
  'test-bench': 'IconListCheck',
  jobs: 'IconCalendarTime',
  // IconTimer does not exist in @tabler/icons-react 3.49 (research Pitfall 10).
  habits: 'IconFlame',
  meetings: 'IconUsers',
  canvas: 'IconSchema',
  rooms: 'IconUsersGroup',
  studio: 'IconPhotoSpark',
  feed: 'IconCompass',
  reviews: 'IconInbox',
  settings: 'IconSettings',
  setup: 'IconSettings',
}

/** Tabs named by a prefix and an id (`review:pr:a/b#1`): the title the id's names give it. */
const PREFIXED_TITLE: ReadonlyArray<readonly [string, (id: string) => string]> = [
  ['workspace:', (id) => workspaceTitle(id) ?? id],
  ['agent:', (id) => agentTitle(id) ?? id],
  ['board:', (slug) => boardTitle(slug) ?? slug],
  ['review:', (id) => reviewTitle(id) ?? reviewFallbackTitle(id)],
  ['ticket:', (id) => ticketTabTitle(`ticket:${id}`)],
  ['room:', (id) => roomTitle(id) ?? UNTITLED_ROOM],
]

/** Text only: callers render this as a React child, never as HTML (T-02-35). */
export function tabTitle(place: Place): string {
  if (place.page === 'chat') {
    // A chat the pane has shown goes by its title; a draft or one not shown yet is a new chat.
    return (place.chat && place.chat !== 'draft' ? chatTitle(place.chat) : null) ?? 'New chat'
  }
  if (place.page === 'settings') return `Settings: ${place.settingsSection}`
  const prefixed = PREFIXED_TITLE.find(([prefix]) => place.page.startsWith(prefix))
  if (prefixed) return prefixed[1](place.page.slice(prefixed[0].length))
  if (place.page === 'meetings' && place.meeting)
    return meetingTitle(place.meeting) ?? place.meeting
  if (place.page === 'canvas' && place.canvas) return canvasTitle(place.canvas) ?? place.canvas
  return TITLES[place.page] ?? place.page
}

/** The glyph a tab shows; an agent's tab shows its portrait instead (TabBar). */
export function tabIconName(place: Place): string {
  if (place.page.startsWith('workspace:')) return 'IconFolder'
  if (place.page.startsWith('board:')) return 'IconLayoutDashboard'
  if (place.page.startsWith('review:')) return reviewIconOf(place.page.slice('review:'.length))
  if (place.page.startsWith('room:')) return 'IconUsersGroup'
  if (place.page.startsWith('ticket:')) return 'IconTicket'
  return ICONS[place.page] ?? 'IconFile'
}
