import './guest-row.css'
import type { GuestEntry } from '@evaos/chat-core/guest-entry'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { Markdown } from './markdown/Markdown'
import { useGuestStyle } from './guest-style'
import { WorkCard } from './WorkCard'

/** "Penny joined the chat": a quiet centered line with the guest's face. */
function GuestLine({ entry }: { entry: GuestEntry }) {
  const said = entry.kind === 'join' ? 'joined the chat' : 'left the chat'
  return (
    <div className="eva-guest-line" data-testid="guest-line" data-kind={entry.kind}>
      <AgentPortrait id={entry.agent.id} className="eva-guest-line-face" />
      {entry.agent.title} {said}
    </div>
  )
}

/** What the guest said: its face, its name in its color, a guest pill, a left bar and a faint tint. */
function GuestBubble({ entry }: { entry: GuestEntry }) {
  const style = useGuestStyle(entry.agent)
  return (
    <div className="eva-guest-say" data-testid="guest-say" style={style}>
      <AgentPortrait id={entry.agent.id} className="eva-guest-say-face" />
      <div className="eva-guest-say-body">
        <div className="eva-guest-say-head">
          <span className="eva-guest-say-name">{entry.agent.title}</span>
          <span className="eva-guest-pill">guest</span>
        </div>
        <Markdown text={entry.text ?? ''} />
      </div>
    </div>
  )
}

/** Another assistant in this chat: it joined or left, said something, or works on something. */
export function GuestRow({ entry }: { entry: GuestEntry }) {
  if (entry.kind === 'work') return <WorkCard entry={entry} />
  if (entry.kind === 'say') return <GuestBubble entry={entry} />
  return <GuestLine entry={entry} />
}
