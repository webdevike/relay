import { Button } from '@mantine/core'
import { ToolChat } from '../chat/ChatPane'
import type { Place } from '@evaos/shell-core'
import { agentIdOf, agentOf, startAgent, useAssistants } from './assistants-store'
import { PortraitCard } from './PortraitCard'
import './assistants.css'

/** The start card's portrait, Mantine's `xl` avatar. */
const CARD_PX = 84

/**
 * An agent's page before the host has started its thread (native chat_view::assistant_placeholder):
 * its portrait over a note that says so, and Start sends "Hi <Title>" through Relay. The portrait
 * moves with the agent (PortraitCard): it thinks once Start is on its way and researches or works
 * as Relay hears its tools, until the page becomes its conversation. Once Relay lists the thread,
 * the page is its conversation: in main's chat pane (PageRouter), or as a tool pane's tab the same
 * full chat under that tab's own pane (ToolChat). A tab kept from
 * a registry that has since dropped the agent still shows its id (and the id's portrait), and Start
 * reaches the host's own answer.
 */
export function AgentPage({ place }: { place: Place }) {
  const id = agentIdOf(place) ?? ''
  const loaded = useAssistants((s) => s.data !== null)
  const agent = useAssistants((s) => agentOf(s, id))
  const relayUp = useAssistants((s) => s.data?.relayUp ?? false)
  const starting = useAssistants((s) => s.starting[id] === true)
  const failed = useAssistants((s) => s.failed[id] ?? null)
  if (!loaded) return null
  // The thread exists: this page is a tool pane's tab (main's chat pane shows it otherwise), and
  // it is the whole chat there too: live log, composer, header with the notch.
  if (agent?.file) return <ToolChat place={place} />
  const title = agent?.title ?? id
  return (
    <div className="eva-as-start" data-testid={`agent-start-${id}`}>
      <PortraitCard
        id={id}
        portrait={agent?.avatar ?? { style: 'notionists', seed: id }}
        size={CARD_PX}
        testId={`agent-portrait-${id}`}
      />
      <h2 className="eva-as-start-title">{title} has not started yet.</h2>
      <p className="eva-as-dim eva-as-center">
        Send {title} a message from Relay on your phone, or start {title} from here.
      </p>
      <Button
        mt="sm"
        data-testid={`start-${id}`}
        disabled={!relayUp}
        loading={starting}
        onClick={() => void startAgent(id)}
      >
        Start {title}
      </Button>
      {relayUp ? null : (
        <p className="eva-as-note">Relay is not running, so {title} cannot be started from here.</p>
      )}
      {failed ? (
        <p className="eva-as-note eva-as-failed" role="alert">
          Relay couldn&apos;t start {title}. {failed}
        </p>
      ) : null}
    </div>
  )
}
