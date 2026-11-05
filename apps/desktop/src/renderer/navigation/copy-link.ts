import { notifications } from '@mantine/notifications'
import { appTabOf, pageTabPlace, type ToolTab } from '@evaos/shell-core'
import { browserStore } from '../browser/browser-store'
import { currentSpace, filesStore } from '../files/files-store'
import { registerAction } from '../hotkeys/router'
import { tabsStore } from '../tabs/tabs-store'
import { tabTitle } from '../tabs/tab-meta'
import { paneTabTitle } from '../tiling/pane-tab-meta'
import { tilingStore, toolTabOfId } from '../tiling/tiling-store'
import { addressOfPlace, formatAddress, type TabAddress } from './tab-address'

export interface FocusedLink {
  url: string
  /** What the link names, for the toast. */
  title: string
}

/** The address of a tool tab, or null for one with nothing to link to (a terminal). */
function toolAddress(tab: ToolTab, ws: string): TabAddress | null {
  switch (tab.kind) {
    case 'web': {
      const page = browserStore.getState().tabs.find((t) => t.id === tab.id)
      return page && /^https?:\/\//i.test(page.url) ? { kind: 'web', url: page.url, ws } : null
    }
    case 'files': {
      const space = currentSpace(filesStore.getState())
      if (!space || space.active === null) return null
      const reveal = space.reveal?.path === space.active ? space.reveal.line : undefined
      return {
        kind: 'file',
        path: `${space.root}/${space.active}`,
        ...(reveal === undefined ? {} : { line: reveal }),
        ws,
      }
    }
    case 'page':
      return addressOfPlace(pageTabPlace(tab))
    case 'subagent':
      return { kind: 'chat', file: tab.session }
    case 'experiment-arm':
      return {
        kind: 'page',
        link: {
          kind: 'open',
          page: 'test-bench',
          params: { experiment: tab.experiment, arm: tab.arm },
        },
      }
    default:
      return null
  }
}

function toolTitle(tab: ToolTab): string {
  if (tab.kind === 'web') {
    const page = browserStore.getState().tabs.find((t) => t.id === tab.id)
    return page?.title || page?.url || 'the page'
  }
  if (tab.kind === 'files') {
    const active = currentSpace(filesStore.getState())?.active
    return active ? (active.split('/').pop() ?? active) : 'Files'
  }
  return paneTabTitle(tab)
}

/**
 * The relay:// link to the focused tab: the tab in front of the pane that last had focus (a
 * chat, a web page, a file, a board, a page). Null when it has nothing to link to.
 */
export function focusedLink(): FocusedLink | null {
  const s = tilingStore.getState()
  const pane = s.panes.find((p) => p.id === s.focus) ?? s.panes.find((p) => p.app)
  const id = pane?.active
  if (!id) return null
  const n = appTabOf(id)
  if (n !== null) {
    const tab = tabsStore.getState().tabs.list.find((t) => t.id === n)
    const address = tab ? addressOfPlace(tab.here) : null
    return tab && address ? { url: formatAddress(address), title: tabTitle(tab.here) } : null
  }
  const tool = toolTabOfId(id)
  const address = tool ? toolAddress(tool, s.scope) : null
  return tool && address ? { url: formatAddress(address), title: toolTitle(tool) } : null
}

/** Cmd+Shift+C: copies the focused tab's link and says so. */
export async function copyFocusedLink(
  write: (text: string) => Promise<void> = (t) => navigator.clipboard.writeText(t),
): Promise<FocusedLink | null> {
  const link = focusedLink()
  if (link === null) {
    notifications.show({ message: 'Nothing here has a link.', autoClose: 2000 })
    return null
  }
  try {
    await write(link.url)
  } catch {
    notifications.show({ message: 'Could not copy the link.', color: 'yellow', autoClose: 2000 })
    return null
  }
  notifications.show({ message: `Copied link to ${link.title}`, autoClose: 2000 })
  return link
}

export function startCopyLink(): () => void {
  return registerAction('copy-link', () => void copyFocusedLink())
}
