import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Loader } from '@mantine/core'
import { IconArrowBackUp, IconExternalLink, IconSparkles, IconTool } from '@tabler/icons-react'
import type { AstraItem } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { invoke, on } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { Markdown } from '../chat/markdown/Markdown'
import { fail } from './review-ui'

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
      if (s.url === url) setItem(s)
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

/**
 * The item's Astra session under the comment box, chat style: Isaac's questions, Astra's answers
 * as Markdown (widgets included) while they stream, tool calls as one quiet line. Use as reply puts
 * an answer in the comment box (posting still asks first); Open session shows it in the chat view.
 */
export function AstraInline({
  item,
  onUseAsReply,
}: {
  item: AstraItem | null
  onUseAsReply: (text: string) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const count = item?.turns.length ?? 0
  const lastText = item?.turns.at(-1)?.text.length ?? 0
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [count, lastText])
  if (!item || item.turns.length === 0) return null

  const open = async (): Promise<void> => {
    if (!item.file) return
    // An idle process lets go first, so the chat view takes the session over cleanly.
    await invoke('reviews.astraRelease', { url: item.url })
    openPlace(placeOf('chat', { chat: item.file }))
  }

  return (
    <section className="eva-rv-astra" data-testid="review-astra">
      <header className="eva-rv-astra-head">
        <IconSparkles size={13} className="eva-rv-accent" />
        <b>{item.title}</b>
        <span className="eva-rv-dim eva-rv-small">private, never posted</span>
        <span className="eva-rv-spacer" />
        {item.working ? (
          <span
            className="eva-rv-dim eva-rv-small eva-rv-reading"
            data-testid="review-astra-working"
          >
            <Loader size={10} /> working
          </span>
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
      </header>
      <div className="eva-rv-astra-body">
        {item.turns.map((t) =>
          t.role === 'user' ? (
            <div key={t.id} className="eva-rv-astra-q" data-testid="review-astra-question">
              {t.text}
            </div>
          ) : t.role === 'tool' ? (
            <div key={t.id} className="eva-rv-astra-tool eva-rv-dim eva-rv-small">
              <IconTool size={11} />
              <span className="eva-rv-ellipsis">{t.text.split('\n', 1)[0]}</span>
            </div>
          ) : (
            <div key={t.id} className="eva-rv-astra-a" data-testid="review-astra-answer">
              <Markdown text={t.text} />
              {t.streaming ? null : (
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconArrowBackUp size={12} />}
                  onClick={() => onUseAsReply(t.text)}
                  data-testid="review-astra-use"
                >
                  Use as reply
                </Button>
              )}
            </div>
          ),
        )}
        {item.waiting ? (
          <div className="eva-rv-astra-wait">
            {item.waiting}: answer it on your phone or in the session.
          </div>
        ) : null}
        {item.error ? <div className="eva-rv-error eva-rv-small">{item.error}</div> : null}
        <div ref={end} />
      </div>
    </section>
  )
}
