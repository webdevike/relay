import { memo, useMemo, useState } from 'react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { splitReplies } from '@evaos/chat-core/replies'
import { ChatImage } from './ChatImage'
import { ImageViewer } from './ImageViewer'
import { Markdown } from './markdown/Markdown'
import { WidgetScope } from './widgets/actions'
import { ToolBlock, ToolGroup } from './ToolRows'
import { BubbleActions } from './reactions/BubbleActions'
import { CanvasRow } from './CanvasRow'
import { BackgroundRow } from './BackgroundRow'
import { parseBackground } from '@evaos/chat-core/background'
import { ReplyChips } from './ReplyChips'

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

function Row({ id, role, children }: { id: string; role: string; children: React.ReactNode }) {
  return (
    <div className="eva-row" data-testid={`msg-${id}`} data-role={role}>
      <div className="eva-row-inner">{children}</div>
    </div>
  )
}

/**
 * A reply without its `[[replies: ...]]` line (cut while it streams in, too), so it never shows,
 * copies or quotes; the newest reply (`live`) shows the answers as buttons under it.
 */
function AssistantBody({ m, live }: { m: ChatMessage; live: boolean }) {
  const split = useMemo(() => splitReplies(m.text, m.streaming), [m.text, m.streaming])
  const shown = useMemo(
    () => (split.text === m.text ? m : { ...m, text: split.text }),
    [m, split.text],
  )
  return (
    <>
      <BubbleActions m={shown} corner="end">
        <WidgetScope.Provider value={m.id}>
          <Markdown text={split.text} />
        </WidgetScope.Provider>
      </BubbleActions>
      {live && !m.streaming && split.replies ? <ReplyChips replies={split.replies} /> : null}
    </>
  )
}

/** `live`: the newest row of an idle chat, the one tap-to-answer replies show under. */
function MessageRowImpl({ m, live = false }: { m: ChatMessage; live?: boolean }) {
  let body
  const background = m.role === 'user' ? parseBackground(m.text) : null
  if (background) {
    body = <BackgroundRow m={background} at={m.at} />
  } else if (m.role === 'user') {
    const text = m.text.trim() !== ''
    // Tapbacks go on the text bubble, or on the images of an image-only prompt.
    body = (
      <div className="eva-turn-user">
        {text ? <Images images={m.images} /> : null}
        <BubbleActions m={m} corner="start">
          {text ? <div className="eva-bubble">{m.text}</div> : <Images images={m.images} />}
        </BubbleActions>
      </div>
    )
  } else if (m.role === 'assistant') {
    body = <AssistantBody m={m} live={live} />
  } else if (m.role === 'thinking') {
    body = <div className="eva-thinking">{m.text}</div>
  } else if (m.role === 'tool') {
    body = <ToolBlock m={m} images={imagesOf(m)} />
  } else if (m.role === 'canvas' && m.canvas) {
    body = <CanvasRow entry={m.canvas} />
  } else {
    body = <div className="eva-notice">{m.text}</div>
  }
  return (
    <Row id={m.id} role={m.role}>
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
