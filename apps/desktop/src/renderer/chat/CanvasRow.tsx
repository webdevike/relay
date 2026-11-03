import './canvas-row.css'
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
function StartCard({ entry }: { entry: CanvasChatEntry }) {
  const live = useRoomLive(entry.roomId)
  const board = entry.board || entry.slug
  return (
    <div className="eva-canvas-card" data-testid="canvas-start" data-live={live === true}>
      <AgentAvatar agent={entry.agent} size={36} />
      <div className="eva-canvas-card-text">
        <div className="eva-canvas-card-title">
          Join {entry.agent.name} on {board}
        </div>
        {entry.text ? (
          <div className="eva-canvas-card-sub" title={entry.text}>
            {entry.text}
          </div>
        ) : null}
      </div>
      {live === true ? (
        <Button
          size="sm"
          data-testid="canvas-join"
          onClick={(e) => joinCanvas(entry.slug, openTargetOf(e))}
        >
          Join
        </Button>
      ) : (
        <div className="eva-canvas-card-actions">
          <span className="eva-canvas-card-state">
            {live === false ? 'Ended' : "Relay isn't connected"}
          </span>
          <Button
            size="sm"
            variant="default"
            data-testid="canvas-open-board"
            onClick={(e) => openBoard(entry.slug, openTargetOf(e))}
          >
            Open board
          </Button>
        </div>
      )}
    </div>
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
function EndCard({ entry }: { entry: CanvasChatEntry }) {
  return (
    <div className="eva-canvas-wrap" data-testid="canvas-end">
      <div className="eva-canvas-wrap-head">
        <IconSchema size={16} stroke={1.5} className="eva-canvas-turn-icon" aria-hidden />
        <span className="eva-canvas-card-title">Canvas wrap-up</span>
        <span className="eva-canvas-card-sub">{entry.board || entry.slug}</span>
        <Button
          size="compact-sm"
          variant="default"
          className="eva-canvas-wrap-open"
          data-testid="canvas-open-board"
          onClick={(e) => openBoard(entry.slug, openTargetOf(e))}
        >
          Open board
        </Button>
      </div>
      {entry.text ? <Markdown text={entry.text} /> : null}
    </div>
  )
}

/** A live canvas row in a chat: the Join card, one canvas turn, or the wrap-up. */
export function CanvasRow({ entry }: { entry: CanvasChatEntry }) {
  if (entry.kind === 'start') return <StartCard entry={entry} />
  if (entry.kind === 'turn') return <TurnRow entry={entry} />
  return <EndCard entry={entry} />
}
