import { memo, useState } from 'react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { ChatImage } from './ChatImage'
import { ImageViewer } from './ImageViewer'
import { Markdown } from './markdown/Markdown'
import { ToolBlock, ToolGroup } from './ToolRows'

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

function MessageRowImpl({ m }: { m: ChatMessage }) {
  let body
  if (m.role === 'user') {
    body = (
      <div className="eva-turn-user">
        <Images images={m.images} />
        {m.text.trim() !== '' ? <div className="eva-bubble">{m.text}</div> : null}
      </div>
    )
  } else if (m.role === 'assistant') {
    body = <Markdown text={m.text} />
  } else if (m.role === 'thinking') {
    body = <div className="eva-thinking">{m.text}</div>
  } else if (m.role === 'tool') {
    body = <ToolBlock m={m} images={imagesOf(m)} />
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
