import {
  IconAsterisk,
  IconFiles,
  IconFlask,
  IconGlobe,
  IconRobot,
  IconStack2,
  type Icon,
} from '@tabler/icons-react'
import type { PaneTab } from '@evaos/shell-core'
import { PAGE_ICONS } from '../tabs/tab-icons'
import { tabIconName, tabTitle } from '../tabs/tab-meta'

const TOOL_TITLES = { browser: 'Browser', files: 'Files', artifacts: 'Artifacts' } as const
const TOOL_ICONS = { browser: IconGlobe, files: IconFiles, artifacts: IconStack2 } as const

/** A tool tab's title, as its pane strip and layout.read name it. Text only. */
export function paneTabTitle(tab: PaneTab): string {
  switch (tab.kind) {
    case 'subagent':
      return tab.name
    case 'experiment-arm':
      return tab.label
    case 'page':
      return tabTitle(tab.place)
    default:
      return TOOL_TITLES[tab.kind]
  }
}

export function paneTabIcon(tab: PaneTab): Icon {
  switch (tab.kind) {
    case 'subagent':
      return IconRobot
    case 'experiment-arm':
      return IconFlask
    case 'page':
      return PAGE_ICONS[tabIconName(tab.place)] ?? IconAsterisk
    default:
      return TOOL_ICONS[tab.kind]
  }
}
