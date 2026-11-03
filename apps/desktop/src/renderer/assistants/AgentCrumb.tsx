import { IconChevronLeft } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { useNamesVersion, agentTitle } from '../eva/names-store'
import { openPlace } from '../navigation/navigate'
import { AgentPortrait } from './AgentPortrait'
import './assistants.css'

/**
 * An agent's page names its way back, like native: "< Assistants / Astra"; the pill goes home. Its
 * portrait and status live in the header's notch (AgentNotch).
 */
export function AgentCrumb({ id }: { id: string }) {
  useNamesVersion()
  return (
    <span className="eva-as-crumb" data-testid="agent-crumb">
      <button
        type="button"
        className="eva-as-crumb-back"
        data-testid="breadcrumb-back"
        onClick={(e) => openPlace(placeOf('assistants'), { newTab: e.metaKey })}
      >
        <IconChevronLeft stroke={2} aria-hidden />
        Assistants
      </button>
      <span className="eva-as-crumb-sep" aria-hidden>
        /
      </span>
      <button
        type="button"
        className="eva-as-crumb-here eva-as-crumb-link"
        data-testid="breadcrumb-agent"
        onClick={(e) => openPlace(placeOf(`agent:${id}`), { newTab: e.metaKey })}
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
        onClick={(e) => openPlace(placeOf(`agent:${agent}`), { newTab: e.metaKey })}
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
