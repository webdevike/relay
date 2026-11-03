import { agentTitle, useNamesVersion } from '../eva/names-store'
import { AgentPortrait } from './AgentPortrait'
import { CrumbStatus } from './CrumbStatus'
import './assistants.css'

/**
 * The agent in its page header, centered on the seam like the mobile notch: the animated portrait
 * and, to its right, its name over a dim one-line status ("idle" at rest). Display only; the
 * header stays draggable through it.
 */
export function AgentNotch({ id }: { id: string }) {
  useNamesVersion()
  return (
    <span className="eva-as-notch" data-testid="agent-notch">
      <AgentPortrait id={id} className="eva-as-notch-portrait" />
      <span className="eva-as-notch-text">
        <span className="eva-as-notch-name">{agentTitle(id) ?? id}</span>
        <CrumbStatus id={id} rest="idle" />
      </span>
    </span>
  )
}
