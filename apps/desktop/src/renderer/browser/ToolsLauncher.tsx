import { useState } from 'react'
import { Kbd, Text, UnstyledButton } from '@mantine/core'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import type { TabState } from '@evaos/contract'
import { invoke } from '../ipc'
import { tilingStore } from '../tiling/tiling-store'
import { openToolIn, TOOLS, type ToolEntry } from '../tiling/tools'

/** Used most first; the rest wait behind "More tools...". */
const PRIMARY = ['terminal', 'files', 'studio'].flatMap((id) => TOOLS.filter((t) => t.id === id))
const MORE = ['canvas', 'test-bench'].flatMap((id) => TOOLS.filter((t) => t.id === id))

function ToolRow({ tool, onOpen }: { tool: ToolEntry; onOpen: (tool: ToolEntry) => void }) {
  const { Icon, label, shortcut } = tool
  return (
    <UnstyledButton
      className="eva-tools-row"
      data-testid={`tools-row-${tool.id}`}
      onClick={() => onOpen(tool)}
    >
      <Icon size={16} stroke={1.5} aria-hidden="true" />
      <Text span className="eva-tools-label">
        {label}
      </Text>
      {shortcut ? <Kbd size="xs">{shortcut}</Kbd> : null}
    </UnstyledButton>
  )
}

/**
 * The new-tab state of the Browser: the URL bar above stays the way to browse; this lists the
 * other tools. A row turns the blank tab into that tool, opened in this pane.
 */
export function ToolsLauncher({ tab }: { tab: TabState | undefined }) {
  const [more, setMore] = useState(false)
  const open = (tool: ToolEntry) => {
    // The pane holding the Browser tab: the tool lands there, in front.
    const pane = tilingStore.getState().panes.find((p) => p.views.includes('browser'))?.id
    if (pane === undefined) return
    openToolIn(tool.add, pane)
    if (tab?.blank) void invoke('browser.closeTab', { tabId: tab.id })
  }
  return (
    <div className="eva-tools" data-testid="page-blank">
      <h2 className="eva-tools-title">Tools</h2>
      <div className="eva-tools-grid" data-testid="tools-grid">
        {PRIMARY.map((tool) => (
          <ToolRow key={tool.id} tool={tool} onOpen={open} />
        ))}
        <UnstyledButton
          className="eva-tools-row"
          data-testid="tools-more"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          <Text span className="eva-tools-label eva-tools-more">
            More tools...
          </Text>
          {more ? (
            <IconChevronDown size={16} stroke={1.5} aria-hidden="true" />
          ) : (
            <IconChevronRight size={16} stroke={1.5} aria-hidden="true" />
          )}
        </UnstyledButton>
        {more ? MORE.map((tool) => <ToolRow key={tool.id} tool={tool} onOpen={open} />) : null}
      </div>
      <p className="eva-dim eva-tools-hint">
        Or type a web address, a search, or a local port such as 3000 above.
      </p>
    </div>
  )
}
