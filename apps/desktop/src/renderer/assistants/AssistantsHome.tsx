import { Button } from '@mantine/core'
import { useState } from 'react'
import { IconMessageChatbot, IconPlus } from '@tabler/icons-react'
import { placeOf, type Place } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { pageMeta } from '../pages/page-meta'
import { ListEmpty } from '../ui/list'
import { createAgent, useAssistants } from './assistants-store'
import { AssistantsGrid } from './AssistantsGrid'
import './assistants.css'

/**
 * The Assistants home: the heading with its subtext, then a grid of cards, one per registry
 * agent (AssistantsGrid): its portrait, title, status and the age of its last reply. Scope and
 * the reply itself are in the hover text.
 */
export function AssistantsHome({ place }: { place: Place }) {
  const data = useAssistants((s) => s.data)
  const meta = pageMeta(place)
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // One click: Relay Host adds "New assistant" and opens its thread; it gets to know Isaac by chatting.
  const create = (): void => {
    setCreating(true)
    setFailed(null)
    createAgent()
      .then((id) => openPlace(placeOf(`agent:${id}`)))
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false))
  }
  return (
    <div className="eva-as-col" data-testid="assistants-home">
      <div className="eva-as-head">
        <div className="eva-as-head-row">
          <h1 className="eva-as-title" data-page-title>
            {meta.title}
          </h1>
          <Button
            variant="default"
            size="xs"
            leftSection={<IconPlus size={14} stroke={1.5} aria-hidden />}
            disabled={data?.relayUp !== true}
            title={data?.relayUp === true ? undefined : 'Relay is not connected'}
            loading={creating}
            onClick={create}
            data-testid="assistants-new"
          >
            New assistant
          </Button>
        </div>
        <p className="eva-as-dim">{meta.description}</p>
        {failed === null ? null : (
          <p className="eva-as-dim eva-as-error" data-testid="assistants-new-error">
            {failed}
          </p>
        )}
      </div>
      {data === null ? null : data.agents.length === 0 ? (
        <ListEmpty
          data-testid="assistants-empty"
          icon={<IconMessageChatbot size={28} stroke={1.5} aria-hidden />}
          title="No assistants yet"
        >
          Create one with New assistant: it sets itself up in its first chat with you.
        </ListEmpty>
      ) : (
        <AssistantsGrid agents={data.agents} />
      )}
    </div>
  )
}
