import { useEffect, useState } from 'react'
import { Button, Tooltip } from '@mantine/core'
import { IconPlayerPause, IconPlayerPlay, IconPlayerStop } from '@tabler/icons-react'
import { councilResumeCap } from '@relay/protocol'
import { roomIsLive, type RoomCouncil } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { ScrollArea } from '../ui/ScrollArea'
import { fullRouting } from './council-view'
import { EffortDial } from './EffortDial'
import { PhaseStrip } from './PhaseStrip'
import { RoomComposer } from './RoomComposer'
import { RoomFeed } from './RoomFeed'
import { WhereStrip } from './RoomKeepUp'
import { RoomSetupForm } from './RoomSetupForm'
import {
  pauseRoom,
  raiseRoom,
  resumeRoom,
  roomIdOf,
  setEditing,
  stopRoom,
  updateRoom,
  useRooms,
} from './rooms-store'
import { SpendMeter } from './SpendMeter'
import type { Room, RoomPhase } from './types'
import './rooms.css'

const PHASE_LABEL: Record<RoomPhase, string> = {
  idle: 'Idle',
  open: 'Live',
  wrapping: 'Wrapping up',
  resolved: 'Resolved',
  failed: 'Failed',
  paused: 'Paused',
  proposed: 'Proposed',
}

/** "0:42", "12:05", "1:02:09". */
function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

function useNow(tick: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!tick) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [tick])
  return now
}

/** The phase, the judge's last word as its tooltip (or the failure). */
function StatusPill({ room }: { room: Room }) {
  const note = room.phase === 'failed' ? room.error : room.judge?.note
  const pill = (
    <span className="eva-rooms-pill" data-status={room.phase} data-testid="room-phase">
      {PHASE_LABEL[room.phase]}
    </span>
  )
  return note ? (
    <Tooltip label={note} openDelay={300} multiline maw={320}>
      {pill}
    </Tooltip>
  ) : (
    pill
  )
}

/** Council: Pause (at the end of this round) while it runs; Resume once it stops. */
function CouncilRunButton({ room, council }: { room: Room; council: RoomCouncil }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const act = (fn: (id: string) => Promise<string | null>): void => {
    setBusy(true)
    setError(null)
    void fn(room.id).then((e) => {
      setBusy(false)
      setError(e)
    })
  }
  if (roomIsLive(room.phase)) {
    if (room.phase !== 'open' || council.paused) return null
    const pausing = council.pauseRequested === true
    return (
      <Tooltip
        label={error ?? 'Stop at the end of this round; Resume carries on with the same people'}
        openDelay={300}
        multiline
        maw={280}
      >
        <Button
          variant="default"
          size="sm"
          leftSection={<IconPlayerPause size={14} stroke={1.5} />}
          disabled={pausing || busy}
          onClick={() => act(pauseRoom)}
          data-testid="room-pause"
        >
          {pausing ? 'Pausing after this round' : 'Pause'}
        </Button>
      </Tooltip>
    )
  }
  const cap = councilResumeCap(council.spend)
  return (
    <Tooltip
      label={error ?? `Run on from the next round with the same people, up to $${cap.toFixed(2)}`}
      openDelay={300}
      multiline
      maw={280}
    >
      <Button
        variant={room.phase === 'paused' ? 'filled' : 'default'}
        size="sm"
        leftSection={<IconPlayerPlay size={14} stroke={1.5} />}
        disabled={busy}
        onClick={() => act(resumeRoom)}
        data-testid="room-resume"
      >
        Resume
      </Button>
    </Tooltip>
  )
}

/** A council room as it shipped: its dial, meter, phases and cards (the title is in the page header). */
function CouncilRoomView({ room, council }: { room: Room; council: RoomCouncil }) {
  const live = roomIsLive(room.phase)
  const now = useNow(live)
  return (
    <div className="eva-rooms-shell">
      <div className="eva-rooms-main" data-testid={`room-${room.id}`}>
        <div className="eva-rooms-header">
          <div className="eva-rooms-council-bar" data-testid="room-council-bar">
            <EffortDial
              live
              effort={council.effort}
              routing={fullRouting(council.routing)}
              onRaise={live ? () => raiseRoom(room.id) : undefined}
              testid="room-effort-dial"
            />
            <SpendMeter council={council} />
          </div>
          <span className="eva-room-head-fill" />
          <StatusPill room={room} />
          <span className="eva-rooms-clock" data-testid="room-clock">
            {clockLabel((room.resolvedAt ?? now) - room.startedAt)}
          </span>
          <CouncilRunButton room={room} council={council} />
          {live ? (
            <Button
              variant="default"
              size="sm"
              leftSection={<IconPlayerStop size={14} stroke={1.5} />}
              onClick={() => void stopRoom(room.id)}
              data-testid="room-stop"
            >
              Resolve now
            </Button>
          ) : null}
        </div>
        <PhaseStrip council={council} resolved={room.phase === 'resolved'} />
        <RoomFeed room={room} />
        <RoomComposer room={room} />
      </div>
    </div>
  )
}

/** A chat room: the notch's room under the header, the log (a quiet hint while empty), the composer. */
function ChatRoomView({ room }: { room: Room }) {
  return (
    <div className="eva-rooms-main" data-testid={`room-${room.id}`} data-phase={room.phase}>
      <div className="eva-chat-notch-room" aria-hidden />
      <WhereStrip room={room} />
      {room.messages.length === 0 ? (
        <div className="eva-room-empty" data-testid="room-empty">
          {room.phase === 'proposed'
            ? 'A proposed council. Send the question to convene it.'
            : "Everyone's here. Nothing runs until you send the first message."}
        </div>
      ) : (
        <RoomFeed key={room.id} room={room} />
      )}
      <RoomComposer key={room.id} room={room} />
    </div>
  )
}

/** One room under Assistants > Rooms (`room:<id>`). */
export function RoomPage({ place }: { place: Place }) {
  const id = roomIdOf(place.page) ?? ''
  const room = useRooms((s) => s.rooms[id] ?? null)
  const editing = useRooms((s) => s.editing === id)
  if (!room) {
    return (
      <div className="eva-room-empty" data-testid="room-missing">
        This room is gone.
      </div>
    )
  }
  if (room.council) return <CouncilRoomView room={room} council={room.council} />
  const setup = room.chat?.setup
  if (editing && setup) {
    return (
      <ScrollArea className="eva-page-scroll" data-testid="room-edit">
        <RoomSetupForm
          initial={setup}
          submitLabel="Save"
          onCancel={() => setEditing(null)}
          onSubmit={async (next) => {
            const e = await updateRoom(room.id, {
              ...next,
              folder: next.folder ?? null,
              draft: next.draft ?? null,
            })
            if (e === null) setEditing(null)
            return e
          }}
        />
      </ScrollArea>
    )
  }
  return <ChatRoomView room={room} />
}
