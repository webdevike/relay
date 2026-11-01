import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Loader } from '@mantine/core'
import {
  IconArrowBackUp,
  IconExternalLink,
  IconLock,
  IconPlayerStopFilled,
  IconTool,
} from '@tabler/icons-react'
import { astraItemUrl, type AstraItem } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { invoke, on } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { Markdown } from '../chat/markdown/Markdown'
import { AgentPortrait } from '../assistants/AgentPortrait'
import { agoPhrase } from './review-model'
import { Avatar, fail } from './review-ui'
import { astraBlocks, type AstraBlock } from './astra-timeline'

/**
 * An item's Astra session as Reviews holds it: loaded on open, kept current from main's updates,
 * and `ask` to start or continue it. `context` is read only when the ask starts the session.
 */
export function useAstraItem(url: string): {
  item: AstraItem | null
  asking: boolean
  ask: (text: string, label: string, context: () => string) => Promise<boolean>
} {
  const [item, setItem] = useState<AstraItem | null>(null)
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    let live = true
    setItem(null)
    void invoke('reviews.astraThread', { url }).then((r) => {
      if (live && r.ok) setItem(r.value)
    })
    const off = on('reviews.astraUpdate', (s) => {
      // Main keeps a Linear ticket's session under its key, whichever link opened it.
      if (s.url === astraItemUrl(url)) setItem(s)
    })
    return () => {
      live = false
      off()
    }
  }, [url])
  const ask = useCallback(
    async (text: string, label: string, context: () => string): Promise<boolean> => {
      setAsking(true)
      const r = await invoke('reviews.astraAsk', {
        url,
        label,
        // Only the first ask seeds the session; a follow-up sends the question alone.
        context: item?.file ? '' : context(),
        text,
      })
      setAsking(false)
      if (!r.ok) {
        fail("Couldn't reach Astra", r.error.message)
        return false
      }
      setItem(r.value)
      return true
    },
    [url, item?.file],
  )
  return { item, asking, ask }
}

/** The item's Astra session as timeline cards (empty when there is none). */
export function itemBlocks(item: AstraItem | null): AstraBlock[] {
  if (!item) return []
  return astraBlocks(item.turns, item.working || item.waiting !== null || item.error !== null)
}

/** Which surface's comment card an Astra card dresses as. */
export type AstraCardLook = 'linear' | 'slack' | 'pr'

const LOOK: Record<AstraCardLook, { card: string; body: string }> = {
  linear: { card: 'eva-rv-lcomment', body: 'eva-rv-lcomment-body' },
  slack: { card: 'eva-rv-smsg', body: 'eva-rv-smsg-body' },
  pr: { card: 'eva-rv-comment', body: '' },
}

/**
 * One card of the item's Astra session in its comment timeline, dressed as that surface's comment:
 * Isaac's @Astra ask as his own comment marked Private, or Astra's reply with her portrait, her
 * answers as Markdown (widgets included) growing while they stream and tool calls as one quiet
 * line. Use as reply puts her answer in the comment box (posting still asks first); Open session
 * shows the session in the chat view; Stop ends her running turn. Nothing here is ever posted.
 */
export function AstraCard({
  block,
  item,
  last,
  now,
  look,
  onUseAsReply,
}: {
  block: AstraBlock
  item: AstraItem
  /** The session's newest card: it carries her working, waiting and error state. */
  last: boolean
  now: number
  look: AstraCardLook
  onUseAsReply: (text: string) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const size = block.kind === 'reply' ? block.turns.reduce((n, t) => n + t.text.length, 0) : 0
  useEffect(() => {
    if (last) end.current?.scrollIntoView({ block: 'nearest' })
  }, [last, size, block.kind])
  const { card, body } = LOOK[look]
  const when =
    block.at === undefined ? null : <span className="eva-rv-dim">{agoPhrase(block.at, now)}</span>

  if (block.kind === 'ask') {
    return (
      <div className={`${card} eva-rv-astra-card`} data-astra="ask" ref={end}>
        <div className="eva-rv-comment-head">
          <Avatar login="Isaac" />
          <b>Isaac</b>
          {when}
          <span className="eva-rv-spacer" />
          <span className="eva-rv-astra-private">
            <IconLock size={11} /> Private
          </span>
        </div>
        <div className={`${body} eva-rv-astra-q`} data-testid="review-astra-question">
          {block.turn.text}
        </div>
      </div>
    )
  }

  const open = async (): Promise<void> => {
    if (!item.file) return
    // An idle process lets go first, so the chat view takes the session over cleanly.
    await invoke('reviews.astraRelease', { url: item.url })
    openPlace(placeOf('chat', { chat: item.file }))
  }
  const stop = async (): Promise<void> => {
    const r = await invoke('reviews.astraStop', { url: item.url })
    if (!r.ok) fail("Couldn't stop Astra", r.error.message)
  }
  const answer = block.turns.filter((t) => t.role === 'assistant').at(-1)
  const working = last && item.working
  return (
    <div className={`${card} eva-rv-astra-card`} data-astra="reply" data-testid="review-astra">
      <div className="eva-rv-comment-head">
        <AgentPortrait id="astra" className="eva-rv-astra-face" />
        <b>Astra</b>
        <span className="eva-rv-dim">AI assistant</span>
        {when}
        <span className="eva-rv-spacer" />
        <span className="eva-rv-astra-private" title="Only you see this; it is never posted">
          <IconLock size={11} /> Private, not posted
        </span>
      </div>
      <div className={`${body} eva-rv-astra-a`}>
        {block.turns.map((t) =>
          t.role === 'tool' ? (
            <div key={t.id} className="eva-rv-astra-tool eva-rv-dim eva-rv-small">
              <IconTool size={11} />
              <span className="eva-rv-ellipsis">{t.text.split('\n', 1)[0]}</span>
            </div>
          ) : (
            <div key={t.id} className="eva-rv-astra-answer" data-testid="review-astra-answer">
              <Markdown text={t.text} />
            </div>
          ),
        )}
        {working ? (
          <span
            className="eva-rv-dim eva-rv-small eva-rv-reading"
            data-testid="review-astra-working"
          >
            <Loader size={10} /> working
          </span>
        ) : null}
        {last && item.waiting ? (
          <div className="eva-rv-astra-wait">
            {item.waiting}: answer it on your phone or in the session.
          </div>
        ) : null}
        {last && item.error ? <div className="eva-rv-error eva-rv-small">{item.error}</div> : null}
        <div className="eva-rv-astra-actions">
          {answer && !answer.streaming ? (
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconArrowBackUp size={12} />}
              onClick={() => onUseAsReply(answer.text)}
              data-testid="review-astra-use"
            >
              Use as reply
            </Button>
          ) : null}
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconExternalLink size={12} />}
            disabled={!item.file}
            onClick={() => void open()}
            data-testid="review-astra-open"
          >
            Open session
          </Button>
          {working ? (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              leftSection={<IconPlayerStopFilled size={11} />}
              onClick={() => void stop()}
              data-testid="review-astra-stop"
            >
              Stop
            </Button>
          ) : null}
        </div>
        <div ref={end} />
      </div>
    </div>
  )
}
