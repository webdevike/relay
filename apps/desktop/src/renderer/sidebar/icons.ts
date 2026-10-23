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
  IconRobot,
  IconSchema,
  IconSettings,
  IconUsers,
  type Icon,
} from '@tabler/icons-react'

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
  IconRobot,
  IconSchema,
  IconSettings,
  IconUsers,
}

export const navIcon = (name: string): Icon => ICONS[name] ?? IconFile
