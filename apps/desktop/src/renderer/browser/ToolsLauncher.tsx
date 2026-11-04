import { Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconFile, IconGlobe } from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'
import { showPath } from '../files/files-store'
import { invoke } from '../ipc'
import { recordRecent, useRecent, type RecentItem } from '../tiling/recent'
import { tilingStore } from '../tiling/tiling-store'
import { openToolIn, TOOLS, type ToolEntry } from '../tiling/tools'

/** The tiles, in this order. */
const TILES = ['terminal', 'files', 'studio', 'canvas', 'test-bench'].flatMap((id) =>
  TOOLS.filter((t) => t.id === id),
)
/** How many Recent rows show. */
const SHOWN = 5

const toolOf = (id: string): ToolEntry | undefined => TOOLS.find((t) => t.id === id)

function RecentIcon({ item }: { item: RecentItem }) {
  const Icon =
    item.kind === 'tool'
      ? (toolOf(item.target)?.Icon ?? IconGlobe)
      : item.kind === 'file'
        ? IconFile
        : IconGlobe
  return <Icon size={16} stroke={1.5} aria-hidden="true" />
}

/**
 * The new-tab state of the Browser: the URL bar above stays the way to browse; this lists the
 * other tools as tiles, then what this window opened last. A tile turns the blank tab into that
 * tool, opened in this pane; a Recent row reopens its page, file or tool.
 */
export function ToolsLauncher({ tab }: { tab: TabState | undefined }) {
  const recent = useRecent().slice(0, SHOWN)
  const openTool = (tool: ToolEntry) => {
    // The pane holding the Browser tab: the tool lands there, in front.
    const pane = tilingStore.getState().panes.find((p) => p.views.includes('browser'))?.id
    if (pane === undefined) return
    recordRecent({ kind: 'tool', target: tool.id, name: tool.label, where: 'Tool' })
    openToolIn(tool.add, pane)
    if (tab?.blank) void invoke('browser.closeTab', { tabId: tab.id })
  }
  const reopen = (item: RecentItem) => {
    if (item.kind === 'tool') {
      const tool = toolOf(item.target)
      if (tool) openTool(tool)
    } else if (item.kind === 'url') {
      if (tab) void invoke('browser.navigate', { tabId: tab.id, input: item.target })
      else void invoke('browser.createTab', { url: item.target })
    } else {
      const pane = tilingStore.getState().panes.find((p) => p.views.includes('browser'))?.id
      const files = toolOf('files')
      if (pane === undefined || !files) return
      openToolIn(files.add, pane)
      if (tab?.blank) void invoke('browser.closeTab', { tabId: tab.id })
      void showPath(item.target, null).catch(() => undefined)
    }
  }
  return (
    <div className="eva-tools" data-testid="page-blank">
      <div className="eva-tools-grid" data-testid="tools-grid">
        {TILES.map((tool) => (
          <Tooltip
            key={tool.id}
            label={tool.shortcut}
            disabled={!tool.shortcut}
            openDelay={300}
            withinPortal
          >
            <UnstyledButton
              className="eva-tools-tile"
              data-testid={`tools-tile-${tool.id}`}
              onClick={() => openTool(tool)}
            >
              <tool.Icon size={22} stroke={1.5} aria-hidden="true" />
              <Text span className="eva-tools-label">
                {tool.label}
              </Text>
            </UnstyledButton>
          </Tooltip>
        ))}
      </div>
      {recent.length > 0 ? (
        <div className="eva-tools-recent" data-testid="tools-recent">
          <Text span className="eva-tools-recent-title">
            Recent
          </Text>
          {recent.map((item) => (
            <UnstyledButton
              key={`${item.kind}:${item.target}`}
              className="eva-tools-recent-row"
              data-testid="tools-recent-row"
              onClick={() => reopen(item)}
            >
              <RecentIcon item={item} />
              <Text span className="eva-tools-recent-name">
                {item.name}
              </Text>
              <Text span className="eva-tools-recent-where">
                {item.where}
              </Text>
            </UnstyledButton>
          ))}
        </div>
      ) : null}
    </div>
  )
}
