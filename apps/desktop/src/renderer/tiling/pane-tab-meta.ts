import { IconFiles, IconFlask, IconGlobe, IconRobot, type Icon } from '@tabler/icons-react'
import type { ToolTab } from '@evaos/shell-core'

const TOOL_TITLES = { browser: 'Browser', files: 'Files' } as const
const TOOL_ICONS = { browser: IconGlobe, files: IconFiles } as const

/** A tool tab's title, as its pane strip and layout.read name it. Text only. */
export function paneTabTitle(tab: ToolTab): string {
  switch (tab.kind) {
    case 'subagent':
      return tab.name
    case 'experiment-arm':
      return tab.label
    default:
      return TOOL_TITLES[tab.kind]
  }
}

export function paneTabIcon(tab: ToolTab): Icon {
  switch (tab.kind) {
    case 'subagent':
      return IconRobot
    case 'experiment-arm':
      return IconFlask
    default:
      return TOOL_ICONS[tab.kind]
  }
}
