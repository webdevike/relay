import { agentTitle, useNamesVersion } from '../eva/names-store'
import { AgentEdit, type AgentEditTarget } from './AgentEdit'
import { AgentPortrait } from './AgentPortrait'
import { CrumbStatus } from './CrumbStatus'
import './assistants.css'

/**
 * The agent in its page header, centered on the seam like the mobile notch: the animated portrait
 * and, to its right, its name over a dim one-line status ("idle" at rest). Display only; the
 * header stays draggable through it. In a chat (`edit`) the portrait is the one part that takes the
 * pointer: hovering it shows a pencil that opens the edit menu (AgentEdit).
 */
export function AgentNotch({ id, edit }: { id: string; edit?: AgentEditTarget }) {
  useNamesVersion()
  return (
    <span className="eva-as-notch" data-testid="agent-notch">
      {edit === undefined ? (
        <AgentPortrait id={id} className="eva-as-notch-portrait" />
      ) : (
        <AgentEdit id={id} target={edit}>
          <AgentPortrait id={id} className="eva-as-notch-portrait" />
        </AgentEdit>
      )}
      <span className="eva-as-notch-text">
        <span className="eva-as-notch-name">{agentTitle(id) ?? id}</span>
        <CrumbStatus id={id} rest="idle" />
      </span>
    </span>
  )
}
