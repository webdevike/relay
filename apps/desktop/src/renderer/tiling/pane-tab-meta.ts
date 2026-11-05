import {
  IconAsterisk,
  IconFiles,
  IconFlask,
  IconGlobe,
  IconRobot,
  IconTerminal2,
  type Icon,
} from '@tabler/icons-react'
import { pageTabPlace, type ToolTab } from '@evaos/shell-core'
import type { TabState } from '@evaos/contract'
import { browserStore } from '../browser/browser-store'
import { PAGE_ICONS } from '../tabs/tab-icons'
import { tabIconName, tabTitle } from '../tabs/tab-meta'

const TOOL_TITLES = { browser: 'Browser', files: 'Files', terminal: 'Terminal' } as const
const TOOL_ICONS = { browser: IconGlobe, files: IconFiles, terminal: IconTerminal2 } as const

/** A web page's tab title: its page title, else its address, else "New page". */
export function webPageTitle(page: TabState | undefined): string {
  if (page?.title) return page.title
  if (page?.url) return page.url.replace(/^[a-z]+:\/\//, '').replace(/\/$/, '')
  return 'New page'
}

/** A tool tab's title, as its pane strip and layout.read name it. Text only. */
export function paneTabTitle(tab: ToolTab): string {
  switch (tab.kind) {
    case 'subagent':
      return tab.name
    case 'experiment-arm':
      return tab.label
    case 'page':
      return tabTitle(pageTabPlace(tab))
    case 'web':
      return webPageTitle(browserStore.getState().byId[tab.id])
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
    case 'page':
      return PAGE_ICONS[tabIconName(pageTabPlace(tab))] ?? IconAsterisk
    case 'web':
      return IconGlobe
    default:
      return TOOL_ICONS[tab.kind]
  }
}
