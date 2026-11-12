import './canvas-row.css'
import { StatusCard } from './status-card/StatusCard'
import { Button } from '@mantine/core'
import { IconSchema } from '@tabler/icons-react'
import type { CanvasChatEntry } from '@evaos/chat-core/canvas-live'
import { AgentAvatar } from '../canvas/live/AgentAvatar'
import { useLiveRooms } from '../canvas/live/live-store'
import { openTargetOf } from '../navigation/open-target'
import { joinCanvas, openBoard } from '../canvas/live/return-point'
import { Markdown } from './markdown/Markdown'

/** Whether the entry's room is live now; null while Relay has not said (down, or not yet heard). */
function useRoomLive(roomId: string): boolean | null {
  return useLiveRooms((s) =>
    s.data?.relayUp ? s.data.rooms.some((r) => r.id === roomId && r.live) : null,
  )
}

/** The Join card: who is at which board and why, with Join while the room is live. */
function StartCard({ entry, messageId }: { entry: CanvasChatEntry; messageId: string }) {
  const live = useRoomLive(entry.roomId)
  const board = entry.board || entry.slug
  return (
    <StatusCard
      id={`canvas:${messageId}`}
      testId="canvas-start"
      data={{ 'data-live': String(live === true) }}
      lead={<AgentAvatar agent={entry.agent} size={22} />}
      line={`Join ${entry.agent.name} on ${board}`}
      lineTitle={`Join ${entry.agent.name} on ${board}`}
      details={entry.text ? <div data-testid="canvas-start-why">{entry.text}</div> : undefined}
      actions={
        live === true ? (
          <Button
            size="compact-xs"
            data-testid="canvas-join"
            onClick={(e) => joinCanvas(entry.slug, openTargetOf(e))}
          >
            Join
          </Button>
        ) : (
          <Button
            size="compact-xs"
            variant="default"
            data-testid="canvas-open-board"
            onClick={(e) => openBoard(entry.slug, openTargetOf(e))}
          >
            Open board
          </Button>
        )
      }
      meta={live === true ? undefined : live === false ? 'Ended' : "Relay isn't connected"}
    />
  )
}

/** One exchange at the canvas: what Isaac said there and the agent's answer. */
function TurnRow({ entry }: { entry: CanvasChatEntry }) {
  return (
    <div className="eva-canvas-turn" data-testid="canvas-turn">
      <IconSchema
        size={14}
        stroke={1.5}
        className="eva-canvas-turn-icon"
        aria-label="On the canvas"
      />
      <div className="eva-canvas-turn-lines">
        {entry.human ? (
          <div>
            <span className="eva-canvas-turn-who">{entry.human.name}:</span> {entry.human.text}
          </div>
        ) : null}
        {entry.text ? (
          <div>
            <span className="eva-canvas-turn-who">{entry.agent.name}:</span> {entry.text}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The wrap-up: the agent's summary of the canvas session, and the board it left. */
function EndCard({ entry, messageId }: { entry: CanvasChatEntry; messageId: string }) {
  return (
    <StatusCard
      id={`canvas:${messageId}`}
      testId="canvas-end"
      lead={<IconSchema size={16} stroke={1.5} className="eva-canvas-turn-icon" aria-hidden />}
      line={`Canvas wrap-up · ${entry.board || entry.slug}`}
      lineTitle={`Canvas wrap-up · ${entry.board || entry.slug}`}
      details={entry.text ? <Markdown text={entry.text} /> : undefined}
      actions={
        <Button
          size="compact-xs"
          variant="default"
          data-testid="canvas-open-board"
          onClick={(e) => openBoard(entry.slug, openTargetOf(e))}
        >
          Open board
        </Button>
      }
    />
  )
}

/** A live canvas row in a chat: the Join card, one canvas turn, or the wrap-up. */
export function CanvasRow({ entry, messageId }: { entry: CanvasChatEntry; messageId: string }) {
  if (entry.kind === 'start') return <StartCard entry={entry} messageId={messageId} />
  if (entry.kind === 'turn') return <TurnRow entry={entry} />
  return <EndCard entry={entry} messageId={messageId} />
}
