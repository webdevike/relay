// A chat room's decision cards in the minimal style (Eva rooms-assistants-proto decisions.css):
// one faint fill, no border, one line where it fits, actions on hover unless Isaac must act, and
// the accent tint ("For you", "Your call") on what waits on him. The cards draw from props and
// report Isaac's actions through callbacks, so a 1:1 chat can show a DecisionRecord too.
import { useState, type ReactNode } from 'react'
import { Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconArrowsDiff,
  IconCheck,
  IconExternalLink,
  IconGavel,
  IconHandFinger,
  IconMessageQuestion,
  IconRotate2,
} from '@tabler/icons-react'
import {
  pollLeader,
  pollTally,
  type ChatRoomMember,
  type DecideAction,
  type DecisionCard,
  type DecisionKindCard,
  type PollCard,
  type ProsConsCard,
  type QuestionCard,
  type RoomCard,
} from '@evaos/contract'
import { MemberFace } from './MemberStack'
import {
  answerAsk,
  answerRoomAsk,
  callRoomPoll,
  decideInRoom,
  reopenRoomPoll,
  voteInRoom,
} from './rooms-store'
import { ISAAC, type Room } from './types'
import './decisions.css'

/** Who an author id is on a card: a name, and the room member whose face it wears. */
export interface DecisionPerson {
  name: string
  member?: ChatRoomMember | undefined
}
export type DecisionPeople = (id: string) => DecisionPerson

/** The people of a chat room: its members, Isaac as "You", anyone else by id. */
export function roomPeople(room: Pick<Room, 'agents' | 'chat'>): DecisionPeople {
  return (id) => {
    if (id === ISAAC) return { name: 'You' }
    const member = room.chat?.setup.members.find((m) => m.id === id)
    return { name: member?.name ?? room.agents.find((a) => a.id === id)?.name ?? id, member }
  }
}

/** One small face: a member's, Isaac's accent "I", else a letter. */
function Face({ id, people }: { id: string; people: DecisionPeople }) {
  const p = people(id)
  if (p.member) return <MemberFace member={p.member} className="eva-dec-face" />
  return (
    <span className="eva-dec-face" data-me={id === ISAAC || undefined}>
      {id === ISAAC ? 'I' : (Array.from(p.name)[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** Overlapping faces, their names on hover. */
function Faces({ ids, people }: { ids: readonly string[]; people: DecisionPeople }) {
  if (ids.length === 0) return null
  return (
    <Tooltip label={ids.map((id) => people(id).name).join(', ')} openDelay={300}>
      <span className="eva-dec-faces">
        {ids.map((id) => (
          <Face key={id} id={id} people={people} />
        ))}
      </span>
    </Tooltip>
  )
}

/** A hover-only icon action in a card's head. */
function HoverAction({
  label,
  onClick,
  children,
  testId,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  testId: string
}) {
  return (
    <Tooltip label={label} openDelay={300}>
      <UnstyledButton
        className="eva-dec-icon"
        aria-label={label}
        data-testid={testId}
        onClick={onClick}
      >
        {children}
      </UnstyledButton>
    </Tooltip>
  )
}

/** Runs one of Isaac's actions; its refusal shows under the card until the next try. */
function useAct(): [string | null, (run: () => Promise<string | null>) => void] {
  const [error, setError] = useState<string | null>(null)
  return [
    error,
    (run) => {
      setError(null)
      void run().then(setError)
    },
  ]
}

export interface PollViewProps {
  card: PollCard
  people: DecisionPeople
  /** Everyone who may vote (the members and Isaac): the "n of m" and the bars' scale. */
  voters: number
  onVote?: (option: string) => Promise<string | null>
  onCall?: () => Promise<string | null>
  onReopen?: () => Promise<string | null>
}

/** A vote: one row per option with who picked it and a bar; tap to vote, hover to call or reopen. */
export function PollView({ card, people, voters, onVote, onCall, onReopen }: PollViewProps) {
  const [error, act] = useAct()
  const tally = pollTally(card)
  const leader = pollLeader(card)
  const voted = Object.keys(card.votes).length
  const done = card.state === 'called' && card.called !== undefined
  const mine = card.votes[ISAAC]
  return (
    <div
      className="eva-dec"
      data-kind="poll"
      data-done={done || undefined}
      data-testid={`decision-poll-${card.id}`}
      data-state={card.state}
    >
      <div className="eva-dec-head">
        <span className="eva-dec-q">{card.question}</span>
        <span className="eva-dec-hover">
          {done && onReopen ? (
            <HoverAction label="Reopen the vote" testId="poll-reopen" onClick={() => act(onReopen)}>
              <IconRotate2 size={14} stroke={1.5} />
            </HoverAction>
          ) : null}
          {!done && onCall ? (
            <HoverAction label="Call it" testId="poll-call" onClick={() => act(onCall)}>
              <IconGavel size={14} stroke={1.5} />
            </HoverAction>
          ) : null}
        </span>
        {done ? (
          <Tooltip label={`Called by ${people(card.called!.by).name}`} openDelay={300}>
            <span className="eva-dec-meta" data-ok>
              <IconCheck size={14} stroke={1.5} aria-hidden />
              Decided
            </span>
          </Tooltip>
        ) : (
          <span className="eva-dec-meta">
            {voted} of {voters}
          </span>
        )}
      </div>
      <div className="eva-dec-options">
        {card.options.map((o) => {
          const who = tally[o.id] ?? []
          const state = done
            ? card.called!.option === o.id
              ? 'win'
              : 'lose'
            : leader === o.id
              ? 'lead'
              : undefined
          return (
            <UnstyledButton
              key={o.id}
              className="eva-dec-option"
              data-state={state}
              data-mine={mine === o.id || undefined}
              data-testid={`poll-option-${o.id}`}
              disabled={done || !onVote}
              aria-pressed={mine === o.id}
              aria-label={
                mine === o.id ? `Take back your vote for ${o.label}` : `Vote for ${o.label}`
              }
              onClick={() => onVote && act(() => onVote(o.id))}
            >
              <span className="eva-dec-option-label">{o.label}</span>
              <Faces ids={who} people={people} />
              <span className="eva-dec-option-n">{who.length}</span>
              <span className="eva-dec-bar" aria-hidden>
                <i style={{ width: `${voters > 0 ? (who.length / voters) * 100 : 0}%` }} />
              </span>
            </UnstyledButton>
          )
        })}
      </div>
      {error ? <div className="eva-dec-error">{error}</div> : null}
    </div>
  )
}

/** Tradeoffs in two columns; a check is a point everyone takes, split arrows one someone disputes. */
export function ProsConsView({ card, people }: { card: ProsConsCard; people: DecisionPeople }) {
  const [open, setOpen] = useState(false)
  const shown = open ? Infinity : 3
  const hidden = Math.max(0, card.pros.length - 3) + Math.max(0, card.cons.length - 3)
  const disputed = [...card.pros, ...card.cons].filter((p) => p.state === 'disputed').length
  const column = (title: string, points: ProsConsCard['pros']) => (
    <div className="eva-dec-col">
      <div className="eva-dec-col-title">{title}</div>
      {points.slice(0, shown).map((p) => (
        <div
          key={p.text}
          className="eva-dec-point"
          data-disputed={p.state === 'disputed' || undefined}
        >
          {p.by[0] ? (
            <Face id={p.by[0]} people={people} />
          ) : (
            <span className="eva-dec-face" data-empty />
          )}
          <span className="eva-dec-point-text">{p.text}</span>
          <Tooltip
            label={
              p.state === 'disputed'
                ? `Disputed by ${(p.against ?? []).map((id) => people(id).name).join(', ')}`
                : p.by.length > 1
                  ? `Backed by ${p.by.map((id) => people(id).name).join(', ')}`
                  : 'Nobody disputes it'
            }
            openDelay={300}
          >
            <span className="eva-dec-mark">
              {p.state === 'disputed' ? (
                <IconArrowsDiff size={14} stroke={1.5} />
              ) : (
                <IconCheck size={14} stroke={1.5} />
              )}
            </span>
          </Tooltip>
        </div>
      ))}
    </div>
  )
  return (
    <div className="eva-dec" data-kind="proscons" data-testid={`decision-proscons-${card.id}`}>
      <div className="eva-dec-head">
        <span className="eva-dec-q">{card.subject}</span>
        <span className="eva-dec-meta">
          <IconArrowsDiff size={14} stroke={1.5} aria-hidden />
          {disputed} disputed
        </span>
      </div>
      <div className="eva-dec-pc">
        {column('For', card.pros)}
        {column('Against', card.cons)}
      </div>
      {hidden > 0 ? (
        <UnstyledButton className="eva-dec-link" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `${hidden} more`}
        </UnstyledButton>
      ) : null}
    </div>
  )
}

/** A member's question for Isaac: tinted with one-tap answers; once answered, one quiet line. */
export function QuestionView({
  card,
  people,
  onAnswer,
}: {
  card: QuestionCard
  people: DecisionPeople
  onAnswer?: (answer: string) => Promise<string | null>
}) {
  const [error, act] = useAct()
  if (card.answered !== undefined) {
    return (
      <div
        className="eva-dec-line"
        data-testid={`decision-question-${card.id}`}
        data-state="answered"
      >
        <Face id={card.by} people={people} />
        <span className="eva-dec-line-text">{card.text}</span>
        <span>You: {card.answered}</span>
      </div>
    )
  }
  return (
    <div
      className="eva-dec"
      data-you
      data-kind="question"
      data-testid={`decision-question-${card.id}`}
    >
      <div className="eva-dec-head">
        <IconMessageQuestion size={16} stroke={1.5} aria-hidden className="eva-dec-head-icon" />
        <span className="eva-dec-q">{card.text}</span>
        <span className="eva-dec-you">
          <IconHandFinger size={14} stroke={1.5} aria-hidden />
          For you
        </span>
      </div>
      {card.sub ? <div className="eva-dec-why">{card.sub}</div> : null}
      {onAnswer ? (
        <div className="eva-dec-actions">
          {card.answers.map((a, i) => (
            <UnstyledButton
              key={a}
              className="eva-dec-btn"
              data-testid={`question-answer-${i}`}
              onClick={() => act(() => onAnswer(a))}
            >
              {a}
            </UnstyledButton>
          ))}
        </div>
      ) : null}
      {error ? <div className="eva-dec-error">{error}</div> : null}
    </div>
  )
}

export interface DecisionRecordProps {
  card: DecisionCard
  people: DecisionPeople
  /** Isaac's call; without it the record is read-only. */
  onDecide?: (action: DecideAction, option?: string) => Promise<string | null>
  /** A hover action that opens where it was decided (a council room). */
  onOpen?: () => void
}

/**
 * The call: what was decided and why, who agrees and who dissents, what happens next and who
 * does it. A proposed call is Isaac's: Accept, one of the alternatives instead, or Reopen.
 */
export function DecisionRecord({ card, people, onDecide, onOpen }: DecisionRecordProps) {
  const [error, act] = useAct()
  const proposed = card.state === 'proposed'
  return (
    <div
      className="eva-dec"
      data-you={proposed || undefined}
      data-kind="decision"
      data-state={card.state}
      data-testid={`decision-record-${card.id}`}
    >
      <div className="eva-dec-head">
        <IconGavel size={16} stroke={1.5} aria-hidden className="eva-dec-head-icon" />
        <span className="eva-dec-call">{card.title}</span>
        <span className="eva-dec-hover">
          {onOpen ? (
            <HoverAction label="Open the room" testId="decision-open" onClick={onOpen}>
              <IconExternalLink size={14} stroke={1.5} />
            </HoverAction>
          ) : null}
          {!proposed && card.state !== 'reopened' && onDecide ? (
            <HoverAction
              label="Reopen"
              testId="decision-reopen"
              onClick={() => act(() => onDecide('reopen'))}
            >
              <IconRotate2 size={14} stroke={1.5} />
            </HoverAction>
          ) : null}
        </span>
        {proposed ? (
          <span className="eva-dec-you">
            <IconHandFinger size={14} stroke={1.5} aria-hidden />
            Your call
          </span>
        ) : card.state === 'reopened' ? (
          <span className="eva-dec-meta">
            <IconRotate2 size={14} stroke={1.5} aria-hidden />
            Reopened
          </span>
        ) : (
          <span className="eva-dec-meta" data-ok>
            <IconCheck size={14} stroke={1.5} aria-hidden />
            {card.state === 'accepted' ? 'Accepted' : 'Your call'}
          </span>
        )}
      </div>
      {card.why ? <div className="eva-dec-why">{card.why}</div> : null}
      <div className="eva-dec-who">
        {card.agree.length > 0 ? (
          <span className="eva-dec-side">
            <Faces ids={card.agree} people={people} />
            agree
          </span>
        ) : null}
        {card.dissent.map((d) => (
          <Tooltip
            key={d.by}
            label={`${people(d.by).name}${d.note ? `: ${d.note}` : ''}`}
            openDelay={300}
          >
            <span className="eva-dec-side" data-dissent>
              <Face id={d.by} people={people} />
              dissents
            </span>
          </Tooltip>
        ))}
        {card.next ? (
          <>
            <span aria-hidden>·</span>
            {card.next.who ? <Face id={card.next.who} people={people} /> : null}
            <span className="eva-dec-next">{card.next.text}</span>
          </>
        ) : null}
      </div>
      {proposed && onDecide ? (
        <div className="eva-dec-actions">
          <UnstyledButton
            className="eva-dec-btn"
            data-primary
            data-testid="decision-accept"
            onClick={() => act(() => onDecide('accept'))}
          >
            Accept
          </UnstyledButton>
          {card.alternatives.map((a) => (
            <UnstyledButton
              key={a.id}
              className="eva-dec-btn"
              data-testid={`decision-override-${a.id}`}
              title={a.label}
              onClick={() => act(() => onDecide('override', a.id))}
            >
              <span className="eva-dec-btn-label">{`${a.label} instead`}</span>
            </UnstyledButton>
          ))}
          <UnstyledButton
            className="eva-dec-btn"
            data-quiet
            data-testid="decision-reopen-now"
            onClick={() => act(() => onDecide('reopen'))}
          >
            Reopen
          </UnstyledButton>
        </div>
      ) : null}
      {error ? <div className="eva-dec-error">{error}</div> : null}
    </div>
  )
}

/** A room message's decision card, wired to the room's actions. */
export function RoomDecisionCard({ card, room }: { card: DecisionKindCard; room: Room }) {
  const people = roomPeople(room)
  switch (card.type) {
    case 'poll':
      return (
        <PollView
          card={card}
          people={people}
          voters={(room.chat?.setup.members.length ?? 0) + 1}
          onVote={(option) => voteInRoom(room.id, card.id, option)}
          onCall={() => callRoomPoll(room.id, card.id)}
          onReopen={() => reopenRoomPoll(room.id, card.id)}
        />
      )
    case 'proscons':
      return <ProsConsView card={card} people={people} />
    case 'question':
      return (
        <QuestionView
          card={card}
          people={people}
          onAnswer={(answer) => answerRoomAsk(room.id, card.id, answer)}
        />
      )
    case 'decision':
      return (
        <DecisionRecord
          card={card}
          people={people}
          onDecide={(action, option) => decideInRoom(room.id, card.id, action, option)}
        />
      )
  }
}

/**
 * A member's outward action (git push, a deploy, a purchase...) waiting on Isaac: the guard's ask
 * drawn as his question card, Allow / Deny, answered through rooms.answer.
 */
export function SeatAskView({
  card,
  room,
}: {
  card: Extract<RoomCard, { type: 'ask' }>
  room: Room
}) {
  return (
    <QuestionView
      card={{
        type: 'question',
        id: card.askId,
        by: card.agentId,
        text: `Wants to run: ${card.action}`,
        sub: 'It runs only if you allow it.',
        answers: ['Allow', 'Deny'],
        ...(card.answered ? { answered: card.answered === 'allow' ? 'Allow' : 'Deny' } : {}),
      }}
      people={roomPeople(room)}
      onAnswer={(a) => answerAsk(room.id, card.askId, a === 'Allow')}
    />
  )
}
