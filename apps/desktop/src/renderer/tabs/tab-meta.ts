import type { Place } from '@evaos/shell-core'
import {
  agentTitle,
  boardTitle,
  canvasTitle,
  chatTitle,
  meetingTitle,
  workspaceTitle,
} from '../eva/names-store'

const TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  assistants: 'Assistants',
  chat: 'Chat',
  'test-bench': 'Test Bench',
  jobs: 'Jobs',
  habits: 'Habits',
  meetings: 'Meetings',
  canvas: 'Canvas',
  settings: 'Settings',
}

const ICONS: Record<string, string> = {
  dashboard: 'IconLayoutDashboard',
  assistants: 'IconRobot',
  chat: 'IconMessage',
  'test-bench': 'IconListCheck',
  jobs: 'IconCalendarTime',
  // IconTimer does not exist in @tabler/icons-react 3.49 (research Pitfall 10).
  habits: 'IconFlame',
  meetings: 'IconUsers',
  canvas: 'IconSchema',
  settings: 'IconSettings',
}

/** Text only: callers render this as a React child, never as HTML (T-02-35). */
export function tabTitle(place: Place): string {
  if (place.page === 'chat') {
    // A chat the pane has shown goes by its title; a draft or one not shown yet is a new chat.
    return (place.chat && place.chat !== 'draft' ? chatTitle(place.chat) : null) ?? 'New chat'
  }
  if (place.page === 'settings') return `Settings: ${place.settingsSection}`
  if (place.page.startsWith('workspace:')) {
    const id = place.page.slice('workspace:'.length)
    return workspaceTitle(id) ?? id
  }
  if (place.page.startsWith('agent:')) {
    const id = place.page.slice('agent:'.length)
    return agentTitle(id) ?? id
  }
  if (place.page.startsWith('board:')) {
    const slug = place.page.slice('board:'.length)
    return boardTitle(slug) ?? slug
  }
  if (place.page === 'meetings' && place.meeting)
    return meetingTitle(place.meeting) ?? place.meeting
  if (place.page === 'canvas' && place.canvas) return canvasTitle(place.canvas) ?? place.canvas
  return TITLES[place.page] ?? place.page
}

export function tabIconName(place: Place): string {
  if (place.page.startsWith('workspace:')) return 'IconFolder'
  if (place.page.startsWith('agent:')) return 'IconMessage'
  if (place.page.startsWith('board:')) return 'IconLayoutDashboard'
  return ICONS[place.page] ?? 'IconFile'
}
