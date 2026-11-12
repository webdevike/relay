import { useState } from 'react'
import { Button } from '@mantine/core'
import { IconScale, IconUsersGroup } from '@tabler/icons-react'
import { councilMoney, type RoomCardRef } from '@relay/protocol'
import { ROOM_EFFORTS, ROOM_SYSTEM, latestCard } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { openFromNav } from '../navigation/open-in-app'
import type { ClickMods } from '../navigation/open-target'
import { DecisionRecord, roomPeople } from './DecisionCards'
import { whereWeAre } from './decision-view'
import { MemberStack } from './MemberStack'
import { conveneRoom, decideInRoom, declineRoom, setEditing, useRooms } from './rooms-store'
import { ISAAC, type Room } from './types'
import './room-card.css'
import { StatusCard } from '../chat/status-card/StatusCard'

/** "Light · cap $3": the effort's name and the hard cap. */
const effortLine = (effort: number, budget: number): string =>
  `${ROOM_EFFORTS[effort - 1]?.name ?? `Effort ${effort}`} · cap ${councilMoney(budget)}`

const open = (id: string, e: ClickMods): void => openFromNav(placeOf(`room:${id}`), e)

/** The setup form of the room, in edit mode, on the room's page; Save goes through rooms.update. */
const editSetup = (id: string, e: ClickMods): void => {
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
    <StatusCard
      id={`room:${room.id}:ready`}
      testId={`room-card-${room.id}`}
      data={{ 'data-phase': room.phase }}
      lead={
        <span className="eva-room-glyph" aria-hidden>
          <IconUsersGroup size={12} stroke={1.5} />
        </span>
      }
      line={
        <>
          <span className="eva-room-card-kind">Room ready</span>{' '}
          <span data-testid="room-card-title">{room.title}</span>
        </>
      }
      lineTitle={room.title}
      actions={
        <Button size="compact-xs" data-testid="room-card-open" onClick={(e) => open(room.id, e)}>
          Open room
        </Button>
      }
      meta={
        <>
          {rev > 0 ? (
            <span className="eva-room-card-updated" data-testid="room-card-updated">
              Updated ×{rev}
            </span>
          ) : null}
          {state}
        </>
      }
      details={
        <>
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
            <Button
              size="xs"
              variant="default"
              data-testid="room-card-edit"
              onClick={(e) => editSetup(room.id, e)}
            >
              Edit setup
            </Button>
          </div>
        </>
      }
    />
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

/**
 * A convened council: one row with where it stands (Where we are: leaning, decided, questions for
 * Isaac); the whole row opens the room. Once the room makes its call, the card is the decision
 * record, acting on the room.
 */
function CouncilStrip({ room }: { room: Room }) {
  const decision = latestCard(room, 'decision')
  if (decision)
    return (
      <div data-testid={`room-card-${room.id}`} data-phase={room.phase} data-proposal>
        <DecisionRecord
          card={decision}
          people={roomPeople(room)}
          onDecide={(action, option) => decideInRoom(room.id, decision.id, action, option)}
          onOpen={() => openFromNav(placeOf(`room:${room.id}`), {})}
        />
      </div>
    )
  const w = whereWeAre(room)
  const lean =
    w?.lean.kind === 'decided' || w?.lean.kind === 'leaning'
      ? `${w.lean.kind} ${w.lean.text}`
      : w?.lean.kind === 'split'
        ? 'split vote'
        : w?.lean.kind === 'voting'
          ? 'voting'
          : null
  const state =
    room.phase === 'open'
      ? 'in session'
      : room.phase === 'paused'
        ? 'paused'
        : room.messages.some((m) => m.author !== ISAAC && m.author !== ROOM_SYSTEM)
          ? 'waiting on you'
          : 'starting'
  const you = w?.you?.kind === 'question' ? `${w.you.count} for you` : null
  const summary = ['Council', lean ?? state, you].filter((s) => s !== null).join(' · ')
  return (
    <StatusCard
      id={`room:${room.id}:council`}
      testId={`room-card-${room.id}`}
      data={{ 'data-phase': room.phase, 'data-proposal': true }}
      label="Open room"
      lead={<MemberStack room={room} />}
      line={<span data-testid="room-card-strip">{summary}</span>}
      lineTitle={summary}
      onOpen={(e) => open(room.id, e)}
    />
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
