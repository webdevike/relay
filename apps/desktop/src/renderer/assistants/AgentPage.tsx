import { Avatar, Button } from '@mantine/core'
import type { Place } from '@evaos/shell-core'
import { portrait } from '../ui/portrait'
import { agentIdOf, agentOf, startAgent, useAssistants } from './assistants-store'
import './assistants.css'

/**
 * An agent's page before the host has started its thread (native chat_view::assistant_placeholder):
 * its portrait over a note that says so, and Start sends "Hi <Title>" through Relay. Once Relay
 * lists the thread, the page is its conversation in main's chat pane (PageRouter). A tab kept from
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
  const title = agent?.title ?? id
  return (
    <div className="eva-as-start" data-testid={`agent-start-${id}`}>
      <Avatar
        className="eva-as-avatar"
        size="xl"
        radius="xl"
        src={portrait(agent?.avatar ?? id)}
        alt=""
        aria-hidden
        data-testid={`agent-portrait-${id}`}
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
