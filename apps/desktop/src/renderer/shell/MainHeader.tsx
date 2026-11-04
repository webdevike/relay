import { ActionIcon, Kbd, Tooltip } from '@mantine/core'
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import { AgentCrumb } from '../assistants/AgentCrumb'
import { AgentNotch } from '../assistants/AgentNotch'
import { agentIdOf } from '../assistants/assistants-store'
import { useNamesVersion } from '../eva/names-store'
import { ContextButton } from '../context/ContextButton'
import { ArtifactsButton } from '../artifacts/ArtifactsButton'
import { tabTitle } from '../tabs/tab-meta'
import { toggleToolPanes, toolsShown, useTiling } from '../tiling/tiling-store'
import { FOLDED_LABEL, toggleSidebar, useLayout } from './layout-store'

/**
 * A page's header inside its card: its title, context, and in the lead pane the sidebar and
 * panel toggles. The tab strip above only navigates tabs.
 */
export function MainHeader({ place, lead }: { place: Place; lead: boolean }) {
  useNamesVersion()
  const agent = agentIdOf(place)
  const state = useLayout((s) => s.state)
  const panelOpen = useTiling(toolsShown)
  const sidebarLabel =
    state === 'open' ? 'Hide sidebar' : state === 'hidden' ? 'Show sidebar' : FOLDED_LABEL
  const panelLabel = panelOpen ? 'Hide tool panes' : 'Show tool panes'
  return (
    <header className="eva-main-header" data-testid="main-header">
      {lead ? (
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
      ) : null}
      {agent !== null ? (
        <span className="eva-main-header-title">
          <AgentCrumb id={agent} />
        </span>
      ) : (
        <span className="eva-main-header-title">{tabTitle(place)}</span>
      )}
      {agent !== null ? <AgentNotch id={agent} /> : null}
      {agent !== null ? <ArtifactsButton agent={agent} /> : <ContextButton />}
      {lead ? (
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
      ) : null}
    </header>
  )
}
