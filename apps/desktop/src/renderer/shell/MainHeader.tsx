import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react'
import { AgentCrumb } from '../assistants/AgentCrumb'
import { agentIdOf } from '../assistants/assistants-store'
import { useNamesVersion } from '../eva/names-store'
import { ContextButton } from '../context/ContextButton'
import { FOLDED_LABEL } from '../tabs/TabBar'
import { tabTitle } from '../tabs/tab-meta'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { toolsShown } from '@evaos/shell-core'
import { toggleToolPanes, useTiling } from '../tiling/tiling-store'
import { toggleSidebar, useLayout } from './layout-store'

/** Page controls belong inside main's card; the tab strip only navigates tabs. */
export function MainHeader() {
  useNamesVersion()
  const place = useTabs(activePlace)
  const agent = agentIdOf(place)
  const state = useLayout((s) => s.state)
  const panelOpen = useTiling((s) => toolsShown(s.tiling))
  const sidebarLabel =
    state === 'open' ? 'Hide sidebar' : state === 'hidden' ? 'Show sidebar' : FOLDED_LABEL
  const panelLabel = panelOpen ? 'Hide tool panes' : 'Show tool panes'
  return (
    <header className="eva-main-header" data-testid="main-header">
      <Tooltip
        label={
          <span className="eva-tip">
            {sidebarLabel} <Kbd size="xs">⌘B</Kbd>
          </span>
        }
        position="bottom"
        openDelay={400}
      >
        <ActionIcon
          variant="subtle"
          className="eva-header-btn"
          data-testid="sidebar-toggle"
          aria-label={sidebarLabel}
          aria-pressed={state === 'open'}
          onClick={() => toggleSidebar()}
        >
          <IconLayoutSidebar size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
      {agent !== null ? (
        <span className="eva-main-header-title">
          <AgentCrumb id={agent} />
        </span>
      ) : (
        <span className="eva-main-header-title">{tabTitle(place)}</span>
      )}
      <ContextButton />
      <Tooltip
        label={
          <span className="eva-tip">
            {panelLabel} <Kbd size="xs">⌘⇧B</Kbd>
          </span>
        }
        position="bottom-end"
        openDelay={400}
      >
        <ActionIcon
          variant="subtle"
          className="eva-header-btn"
          data-testid="panel-toggle"
          aria-label={panelLabel}
          aria-pressed={panelOpen}
          onClick={() => toggleToolPanes()}
        >
          <IconLayoutSidebarRight size={16} stroke={1.5} />
        </ActionIcon>
      </Tooltip>
    </header>
  )
}
