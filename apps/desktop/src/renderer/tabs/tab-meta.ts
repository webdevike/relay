import type { Place } from '@evaos/shell-core'
import { meetingTitle, workspaceTitle } from '../eva/names-store'

const TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  chat: 'Chat',
  'test-bench': 'Test Bench',
  jobs: 'Jobs',
  habits: 'Habits',
  meetings: 'Meetings',
  settings: 'Settings',
}

const ICONS: Record<string, string> = {
  dashboard: 'IconLayoutDashboard',
  chat: 'IconMessage',
  'test-bench': 'IconListCheck',
  jobs: 'IconCalendarTime',
  // IconTimer does not exist in @tabler/icons-react 3.49 (research Pitfall 10).
  habits: 'IconFlame',
  meetings: 'IconUsers',
  settings: 'IconSettings',
}

/** Text only: callers render this as a React child, never as HTML (T-02-35). */
export function tabTitle(place: Place): string {
  if (place.page === 'chat') return 'New chat'
  if (place.page === 'settings') return `Settings: ${place.settingsSection}`
  if (place.page.startsWith('workspace:')) {
    const id = place.page.slice('workspace:'.length)
    return workspaceTitle(id) ?? id
  }
  if (place.page === 'meetings' && place.meeting)
    return meetingTitle(place.meeting) ?? place.meeting
  return TITLES[place.page] ?? place.page
}

export function tabIconName(place: Place): string {
  if (place.page.startsWith('workspace:')) return 'IconFolder'
  return ICONS[place.page] ?? 'IconFile'
}
