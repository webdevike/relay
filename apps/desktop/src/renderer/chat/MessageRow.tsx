import './asks/asks.css'
import { memo, useContext, useMemo, useState } from 'react'
import { ActionIcon } from '@mantine/core'
import { IconX } from '@tabler/icons-react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { splitReplies } from '@evaos/chat-core/replies'
import { splitPins } from '@evaos/chat-core/pins'
import { stripComputerPlan } from '@evaos/chat-core/computer-plan'
import { ChatImage } from './ChatImage'
import { ImageViewer } from './ImageViewer'
import { Markdown } from './markdown/Markdown'
import { MarkdownMedia } from './markdown/MarkdownMedia'
import { userImageUrls } from '@evaos/chat-core/image-urls'
import { WidgetScope } from './widgets/actions'
import { RenderMessage, type RenderMessageValue } from './widgets/render-report'
import { ReactionScope } from './reactions/reactions-store'
import { reactionKeyOf } from '@evaos/chat-core/reactions'
import { ToolBlock, ToolGroup } from './ToolRows'
import { BubbleActions } from './reactions/BubbleActions'
import { CanvasRow } from './CanvasRow'
import { GuestRow } from './GuestRow'
import { BackgroundRow } from './BackgroundRow'
import { parseBackground } from '@evaos/chat-core/background'
import { splitRoomCards, splitSignin, stripAnswerContext } from '@relay/protocol'
import { RoomCards } from '../rooms/RoomCard'
import { ReplyChips } from './ReplyChips'
import { SignInCard } from './SignInCard'
import { resolveAsk } from './asks/asks-store'
import { useAssistants } from '../assistants/assistants-store'
import { MentionText } from '../rooms/MentionText'
import type { OpenAsk } from '@evaos/contract'

/** Thumbnails for a message's images; Enter or click opens the viewer on that image. */
function Images({ images }: { images: ChatMessage['images'] }) {
  const [open, setOpen] = useState<number | null>(null)
  const [last, setLast] = useState(0)
  if (images.length === 0) return null
  return (
    <>
      <div className="eva-chat-images" data-testid="chat-images">
        {images.map((image, i) => (
          <ChatImage
            key={i}
            image={image}
            index={i}
            total={images.length}
            onOpen={() => {
              setLast(i)
              setOpen(i)
            }}
          />
        ))}
      </div>
      <ImageViewer
        images={images}
        start={last}
        opened={open !== null}
        onClose={() => setOpen(null)}
      />
    </>
  )
}

const imagesOf = (m: ChatMessage) => <Images images={m.images} />

function Row({
  id,
  role,
  waiting = false,
  children,
}: {
  id: string
  role: string
  /** The bubble carries an open ask: a thin accent edge until it is answered. */
  waiting?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className="eva-row"
      data-testid={`msg-${id}`}
      data-role={role}
      data-waiting={waiting || undefined}
    >
      <div className="eva-row-inner">{children}</div>
    </div>
  )
}

/**
 * A reply without its `[[replies: ...]]` line (cut while it streams in, too), so it never shows,
 * copies or quotes; the newest reply (`live`) shows the answers as buttons under it. A
 * `[[signin:<url>]]` line before it becomes the sign-in card above the bubble, as on the phone; a
 * `[[room:<id>]]` line (an assistant set up a room) becomes that room's live card under it.
 */
function AssistantBody({
  m,
  live,
  waiting,
  agent,
}: {
  m: ChatMessage
  live: boolean
  waiting: OpenAsk | undefined
  agent: string | undefined
}) {
  // `[[pin: label | value]]` lines are pins (the host makes them), never shown; an `@computer`
  // plan block is the run's, never shown either; then the replies token, the sign-in token and
  // room tokens.
  const split = useMemo(() => {
    const pinned = splitPins(stripComputerPlan(m.text), m.streaming)
    const answered = splitReplies(pinned.text, m.streaming)
    const signed = splitSignin(answered.text, m.streaming)
    const { text, rooms } = splitRoomCards(signed.text, m.streaming)
    return { ...answered, text, signin: signed.signin, rooms }
  }, [m.text, m.streaming])
  const shown = useMemo(
    () => (split.text === m.text ? m : { ...m, text: split.text }),
    [m, split.text],
  )
  // Media failures in this bubble go to its agent; keyed like reactions so every device agrees.
  const thread = useContext(ReactionScope)?.thread ?? null
  const key = reactionKeyOf(m)
  const renderAt = useMemo<RenderMessageValue | null>(
    () => (thread === null || key === null ? null : { thread, message: key }),
    [thread, key],
  )
  return (
    <>
      {split.signin !== undefined ? (
        <SignInCard signin={split.signin} agent={agent} messageId={m.id} />
      ) : null}
      {(split.signin === undefined && split.rooms.length === 0) || split.text.trim() !== '' ? (
        <BubbleActions m={shown} corner="end">
          <WidgetScope.Provider value={m.id}>
            <RenderMessage.Provider value={renderAt}>
              <Markdown text={split.text} />
            </RenderMessage.Provider>
          </WidgetScope.Provider>
        </BubbleActions>
      ) : null}
      <RoomCards rooms={split.rooms} />
      {waiting !== undefined ? (
        <div className="eva-waiting-tag">
          <span data-testid="waiting-tag">Waiting on you</span>
          {agent !== undefined ? (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="var(--eva-kit-control-xs)"
              className="eva-waiting-dismiss"
              data-testid="waiting-dismiss"
              aria-label="Dismiss this question"
              onClick={() => void resolveAsk(agent, waiting, 'dismissed')}
            >
              <IconX size={12} stroke={1.5} />
            </ActionIcon>
          ) : null}
        </div>
      ) : null}
      {(live || waiting !== undefined) && !m.streaming && split.replies ? (
        <ReplyChips
          replies={split.replies}
          {...(waiting !== undefined && agent !== undefined
            ? { ask: waiting, agent, older: !live }
            : {})}
        />
      ) : null}
    </>
  )
}

/** A user bubble's text, the registry assistants' `@Name`s as the room's chips (@computer and unknown words stay plain). */
function AssistantMentions({ text }: { text: string }) {
  const agents = useAssistants((s) => s.data?.agents)
  const people = useMemo(() => (agents ?? []).map((a) => ({ id: a.id, name: a.title })), [agents])
  return <MentionText text={text} people={people} />
}

/**
 * `live`: the newest row of an idle chat, the one tap-to-answer replies show under. `waiting`: the
 * open ask (of assistant `agent`'s thread) this row carries; it keeps its replies, an accent edge
 * and a tag until the ask closes.
 */
function MessageRowImpl({
  m,
  live = false,
  waiting,
  agent,
}: {
  m: ChatMessage
  live?: boolean
  waiting?: OpenAsk | undefined
  agent?: string | undefined
}) {
  let body
  const background = m.role === 'user' ? parseBackground(m.text) : null
  if (background) {
    body = <BackgroundRow m={background} at={m.at} />
  } else if (m.role === 'user') {
    // A direct image link he typed shows as a picture, not a link.
    const linked = userImageUrls(stripAnswerContext(m.text))
    const text = linked.rest.trim() !== ''
    const pictures = linked.urls.map((src) => <MarkdownMedia key={src} src={src} alt="" />)
    // Tapbacks go on the text bubble, or on the images of an image-only prompt.
    body = (
      <div className="eva-turn-user">
        {text ? <Images images={m.images} /> : null}
        {text ? pictures : null}
        <BubbleActions m={m} corner="start">
          {text ? (
            <div className="eva-bubble">
              <AssistantMentions text={linked.rest} />
            </div>
          ) : (
            <>
              <Images images={m.images} />
              {pictures}
            </>
          )}
        </BubbleActions>
      </div>
    )
  } else if (m.role === 'assistant') {
    body = <AssistantBody m={m} live={live} waiting={waiting} agent={agent} />
  } else if (m.role === 'thinking') {
    body = <div className="eva-thinking">{m.text}</div>
  } else if (m.role === 'tool') {
    body = <ToolBlock m={m} images={imagesOf(m)} />
  } else if (m.role === 'canvas' && m.canvas) {
    body = <CanvasRow entry={m.canvas} messageId={m.id} />
  } else if (m.role === 'guest' && m.guest) {
    body = <GuestRow entry={m.guest} />
  } else {
    body = <div className="eva-notice">{m.text}</div>
  }
  return (
    <Row id={m.id} role={m.role} waiting={waiting !== undefined}>
      {body}
    </Row>
  )
}

export const MessageRow = memo(MessageRowImpl)

/** A run of tool calls folded to one line (Settings > Chat > Show tool details off). */
function ToolRunRowImpl({ tools }: { tools: ChatMessage[] }) {
  return (
    <Row id={`${tools[0]!.id}-tools`} role="tools">
      <ToolGroup tools={tools} images={imagesOf} />
    </Row>
  )
}

const sameRun = (a: { tools: ChatMessage[] }, b: { tools: ChatMessage[] }): boolean =>
  a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i])

export const ToolRunRow = memo(ToolRunRowImpl, sameRun)
