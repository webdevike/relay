import { useRef, type KeyboardEvent } from 'react'
import { IconX } from '@tabler/icons-react'
import type { IDockviewPanelHeaderProps, IDockviewPanelProps } from 'dockview-react'
import { toolTabFromJson, type SubagentTab, type ToolTab } from '@evaos/shell-core'
import { useChatStore } from '../../chat/chat-store'
import { useFrontChatPane } from '../../chat/front-chat'
import { SubagentStateIcon, subagentState, useMinute } from '../../chat/strips/SubagentChips'
import { useNamesVersion } from '../../eva/names-store'
import { paneTabIcon, paneTabTitle } from '../pane-tab-meta'
import { useAttachContent } from '../tab-content'
import { activateTab, closeTab } from '../tiling-store'
import { usePanelActive } from './panel-hooks'

/** A tool tab's content: its node from the content host (tab-content), never remounted here. */
export function ToolPanel({ api }: IDockviewPanelProps) {
  const body = useRef<HTMLDivElement>(null)
  useAttachContent(body, api.id)
  return <div className="eva-pane-body" ref={body} />
}

/** A running subagent's tab spins like its chip while the chat in front is its own. */
function SubagentGlyph({ tab }: { tab: SubagentTab }) {
  const now = useMinute()
  const front = useFrontChatPane()
  const subagent = useChatStore((s) => {
    const pane = s.panes[front]
    if (!pane || pane.file !== tab.session) return undefined
    return pane.extras.subagents.find((a) => a.name === tab.name)
  })
  if (!subagent) {
    const Icon = paneTabIcon(tab)
    return <Icon size={14} stroke={1.5} />
  }
  return <SubagentStateIcon state={subagentState(subagent, now)} />
}

/** A tool tab in its pane's strip: icon, title, and a close button that keeps its room. */
export function ToolTabView({ api, params }: IDockviewPanelHeaderProps<{ tab?: ToolTab }>) {
  useNamesVersion()
  const active = usePanelActive(api)
  const tab = toolTabFromJson(params.tab)
  if (!tab) return null
  const id = api.id
  const title = paneTabTitle(tab)
  const Icon = paneTabIcon(tab)
  const onKey = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    activateTab(id)
  }
  return (
    <div
      className="eva-pane-tab"
      data-active={active || undefined}
      data-pane-tab
      data-testid={`pane-tab-${id}`}
      title={title}
      onKeyDown={onKey}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        closeTab(id)
      }}
    >
      {tab.kind === 'subagent' ? <SubagentGlyph tab={tab} /> : <Icon size={14} stroke={1.5} />}
      <span className="eva-pane-tab-title">{title}</span>
      <button
        type="button"
        className="eva-pane-tab-close"
        tabIndex={-1}
        aria-label={`Close ${title}`}
        data-testid={`pane-tab-close-${id}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          closeTab(id)
        }}
      >
        <IconX size={12} stroke={1.5} />
      </button>
    </div>
  )
}
