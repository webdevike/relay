import { Tooltip } from '@mantine/core'
import { IconChevronLeft } from '@tabler/icons-react'
import type { MouseEvent } from 'react'
import { placeOf, type Place } from '@evaos/shell-core'
import { useNamesVersion, agentTitle } from '../eva/names-store'
import { backOr } from '../navigation/nav-history'
import { openFromNav } from '../navigation/open-in-app'
import { AgentPortrait } from './AgentPortrait'
import './assistants.css'

/**
 * The back arrow is the window's Back (navigation/nav-history.ts). With nothing behind it, or a
 * modified click (a new tab), it opens `home`, where the arrow used to go.
 */
function back(e: MouseEvent, home: Place): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) openFromNav(home, e)
  else backOr(() => openFromNav(home, e))
}

/**
 * An agent's page names its way back and where it is: a back arrow (the window's Back) then the
 * agent's name. Its portrait and status live in the header's notch (AgentNotch).
 */
export function AgentCrumb({ id }: { id: string }) {
  useNamesVersion()
  return (
    <span className="eva-as-crumb" data-testid="agent-crumb">
      <Tooltip label="Back" openDelay={300}>
        <button
          type="button"
          className="eva-as-crumb-back"
          aria-label="Back"
          data-testid="breadcrumb-back"
          onClick={(e) => back(e, placeOf('assistants'))}
        >
          <IconChevronLeft stroke={2} aria-hidden />
        </button>
      </Tooltip>
      <button
        type="button"
        className="eva-as-crumb-here eva-as-crumb-link"
        data-testid="breadcrumb-agent"
        onClick={(e) => openFromNav(placeOf(`agent:${id}`), e)}
      >
        {agentTitle(id) ?? id}
      </button>
    </span>
  )
}

/**
 * A chat an assistant started (auto-work) names its way back to that assistant's thread, where
 * it is listed: "< Astra / ENG-6545 auto-work".
 */
export function OwnedCrumb({ agent, title }: { agent: string; title: string }) {
  useNamesVersion()
  return (
    <span className="eva-as-crumb" data-testid="owned-crumb">
      <button
        type="button"
        className="eva-as-crumb-back"
        data-testid="owned-crumb-back"
        onClick={(e) => openFromNav(placeOf(`agent:${agent}`), e)}
      >
        <IconChevronLeft stroke={2} aria-hidden />
        <AgentPortrait id={agent} className="eva-as-crumb-portrait" />
        {agentTitle(agent) ?? agent}
      </button>
      <span className="eva-as-crumb-sep" aria-hidden>
        /
      </span>
      <span className="eva-as-crumb-here">{title}</span>
    </span>
  )
}
