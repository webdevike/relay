import { useState, type MouseEvent } from 'react'
import { Button } from '@mantine/core'
import { IconArrowUpRight, IconScale, IconUsersGroup } from '@tabler/icons-react'
import { councilMoney, type RoomCardRef } from '@relay/protocol'
import { ROOM_EFFORTS } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { openFromNav } from '../navigation/open-in-app'
import { MemberStack } from './MemberStack'
import { conveneRoom, declineRoom, setEditing, useRooms } from './rooms-store'
import type { Room } from './types'
import './room-card.css'

/** "Light · cap $3": the effort's name and the hard cap. */
const effortLine = (effort: number, budget: number): string =>
  `${ROOM_EFFORTS[effort - 1]?.name ?? `Effort ${effort}`} · cap ${councilMoney(budget)}`

const open = (id: string, e: MouseEvent): void => openFromNav(placeOf(`room:${id}`), e)

/** The setup form of the room, in edit mode, on the room's page; Save goes through rooms.update. */
const editSetup = (id: string, e: MouseEvent): void => {
  setEditing(id)
  open(id, e)
}

/** Runs one of Isaac's actions on the card; its refusal shows under the card until the next try. */
function useAct(): [string | null, boolean, (run: () => Promise<string | null>) => void] {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return [
    error,
    busy,
    (run) => {
      if (busy) return
      setBusy(true)
      setError(null)
      void run().then((e) => {
        setBusy(false)
        setError(e)
      })
    },
  ]
}

/** An assistant's room as its reply's card: a live view, updated in place by rooms.update. */
function ReadyCard({ room }: { room: Room }) {
  const chat = room.chat!
  const { setup, rev } = chat
  const state = room.phase === 'open' ? 'Live' : room.phase === 'paused' ? 'Paused' : 'Idle'
  return (
    <div className="eva-room-card" data-testid={`room-card-${room.id}`} data-phase={room.phase}>
      <div className="eva-room-card-head">
        <span className="eva-room-glyph" aria-hidden>
          <IconUsersGroup size={12} stroke={1.5} />
        </span>
        <span className="eva-room-card-kind">Room ready</span>
        <span className="eva-room-card-fill" />
        {rev > 0 ? (
          <span className="eva-room-card-updated" data-testid="room-card-updated">
            Updated ×{rev}
          </span>
        ) : null}
        <span className="eva-room-card-state">{state}</span>
      </div>
      <div className="eva-room-card-title" data-testid="room-card-title">
        {room.title}
      </div>
      <div className="eva-room-card-people">
        <MemberStack room={room} />
        <span className="eva-room-card-roster" data-testid="room-card-roster">
          {setup.members
            .map((m) => (m.role ? `${m.name.split(/\s+/)[0]} · ${m.role}` : m.name))
            .join(', ')}
        </span>
      </div>
      <dl className="eva-room-card-facts">
        <dt>Effort</dt>
        <dd>{effortLine(setup.effort, setup.budget)}</dd>
        {setup.folder ? (
          <>
            <dt>Folder</dt>
            <dd>
              <code>{setup.folder}</code>
            </dd>
          </>
        ) : null}
      </dl>
      <div className="eva-room-card-actions">
        <Button size="xs" data-testid="room-card-open" onClick={(e) => open(room.id, e)}>
          Open room
        </Button>
        <Button
          size="xs"
          variant="default"
          data-testid="room-card-edit"
          onClick={(e) => editSetup(room.id, e)}
        >
          Edit setup
        </Button>
      </div>
    </div>
  )
}

/** A council an assistant proposed: Convene sends its question as Isaac's first message. */
function ProposalCard({ room }: { room: Room }) {
  const setup = room.chat!.setup
  const [error, busy, act] = useAct()
  return (
    <div
      className="eva-room-card"
      data-testid={`room-card-${room.id}`}
      data-phase={room.phase}
      data-proposal
    >
      <div className="eva-room-card-head">
        <IconScale size={16} stroke={1.5} className="eva-room-card-icon" aria-hidden />
        <span className="eva-room-card-kind" data-testid="room-card-question">
          {setup.draft ?? room.title}
        </span>
      </div>
      <div className="eva-room-card-people">
        <MemberStack room={room} />
        <span className="eva-room-card-roster">{effortLine(setup.effort, setup.budget)}</span>
      </div>
      <div className="eva-room-card-actions">
        <Button
          size="xs"
          data-testid="room-card-convene"
          loading={busy}
          onClick={() => act(() => conveneRoom(room.id))}
        >
          Convene
        </Button>
        <Button
          size="xs"
          variant="default"
          data-testid="room-card-edit"
          onClick={(e) => editSetup(room.id, e)}
        >
          Edit members
        </Button>
        <Button
          size="xs"
          variant="subtle"
          color="gray"
          data-testid="room-card-not-now"
          disabled={busy}
          onClick={() => act(() => declineRoom(room.id))}
        >
          Not now
        </Button>
      </div>
      {error ? <div className="eva-room-card-error">{error}</div> : null}
    </div>
  )
}

/** A convened council: one row with its state; the whole row opens the room. */
function CouncilStrip({ room }: { room: Room }) {
  const state =
    room.phase === 'open'
      ? 'in session'
      : room.phase === 'paused'
        ? 'paused'
        : room.messages.some((m) => m.author !== 'isaac' && m.author !== 'system')
          ? 'waiting on you'
          : 'starting'
  return (
    <button
      type="button"
      className="eva-room-strip"
      data-testid={`room-card-${room.id}`}
      data-phase={room.phase}
      data-proposal
      onClick={(e) => open(room.id, e)}
    >
      <MemberStack room={room} />
      <span className="eva-room-strip-text" data-testid="room-card-strip">
        Council · {state}
      </span>
      <span className="eva-room-strip-open">
        <IconArrowUpRight size={14} stroke={1.5} aria-hidden />
        Open room
      </span>
    </button>
  )
}

/** The card a reply's `[[room:<id>]]` token turns into, keyed by the room so it stays current. */
export function RoomCard({ refRoom }: { refRoom: RoomCardRef }) {
  const room = useRooms((s) => s.rooms[refRoom.id] ?? null)
  const loaded = useRooms((s) => s.loaded)
  const declined = useRooms((s) => s.declined.includes(refRoom.id))
  if (!room) {
    if (!loaded) return null
    return (
      <div className="eva-room-card-gone" data-testid={`room-card-gone-${refRoom.id}`}>
        {declined ? 'Not now' : 'Room deleted'}
        {refRoom.title ? `: ${refRoom.title}` : ''}
      </div>
    )
  }
  if (!room.chat) return null
  if (!room.chat.proposal) return <ReadyCard room={room} />
  return room.phase === 'proposed' ? <ProposalCard room={room} /> : <CouncilStrip room={room} />
}

/** Every room card a reply carries, in order. */
export function RoomCards({ rooms }: { rooms: readonly RoomCardRef[] }) {
  if (rooms.length === 0) return null
  return (
    <div className="eva-room-cards">
      {rooms.map((r) => (
        <RoomCard key={r.id} refRoom={r} />
      ))}
    </div>
  )
}
