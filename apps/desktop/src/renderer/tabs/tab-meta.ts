import type { Place } from '@evaos/shell-core'
import { workspaceTitle } from '../eva/names-store'

const TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  inbox: 'Inbox',
  chat: 'Chat',
  jobs: 'Jobs',
  habits: 'Habits',
  meetings: 'Meetings',
  calendar: 'Calendar',
  tasks: 'Tasks',
  memory: 'Memory',
  files: 'Files',
  settings: 'Settings',
  help: 'Help Center',
}

const ICONS: Record<string, string> = {
  dashboard: 'IconLayoutDashboard',
  inbox: 'IconInbox',
  chat: 'IconMessage',
  jobs: 'IconCalendarTime',
  // IconTimer does not exist in @tabler/icons-react 3.49 (research Pitfall 10).
  habits: 'IconFlame',
  meetings: 'IconUsers',
  calendar: 'IconCalendar',
  tasks: 'IconListCheck',
  memory: 'IconBrain',
  files: 'IconFile',
  settings: 'IconSettings',
  help: 'IconHelp',
}

/** Text only: callers render this as a React child, never as HTML (T-02-35). */
export function tabTitle(place: Place): string {
  if (place.page === 'chat') return 'New chat'
  if (place.page === 'settings') return `Settings: ${place.settingsSection}`
  if (place.page.startsWith('workspace:')) {
    const id = place.page.slice('workspace:'.length)
    return workspaceTitle(id) ?? id
  }
  if (place.page.startsWith('board:')) return place.page.slice('board:'.length)
  return TITLES[place.page] ?? place.page
}

export function tabIconName(place: Place): string {
  if (place.page.startsWith('workspace:')) return 'IconFolder'
  if (place.page.startsWith('board:')) return 'IconListCheck'
  return ICONS[place.page] ?? 'IconFile'
}
