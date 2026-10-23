import { IconChevronLeft } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { useNamesVersion, agentTitle } from '../eva/names-store'
import { openPlace } from '../navigation/navigate'
import './assistants.css'

/** An agent's page names its way back, like native: "< Assistants / Astra"; the pill goes home. */
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
        <IconChevronLeft size={12} stroke={2} aria-hidden />
        Assistants
      </button>
      <span className="eva-as-crumb-sep" aria-hidden>
        /
      </span>
      <span className="eva-as-crumb-here">{agentTitle(id) ?? id}</span>
    </span>
  )
}
