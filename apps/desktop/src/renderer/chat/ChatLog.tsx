import { useLayoutEffect, useRef } from 'react'
import { VList, type VListHandle } from 'virtua'
import type { ChatMessage } from '@evaos/chat-core/message'
import { MessageRow } from './MessageRow'

const PIN_THRESHOLD = 24

/** Virtualized transcript. Pin state is kept in refs; the pills arrive with plan 01-06. */
export function ChatLog({ messages, file }: { messages: ChatMessage[]; file: string }) {
  const ref = useRef<VListHandle>(null)
  const pinned = useRef(true)

  // Open at the end, once per opened file.
  useLayoutEffect(() => {
    pinned.current = true
    const last = messages.length - 1
    if (last >= 0) ref.current?.scrollToIndex(last, { align: 'end' })
  }, [file])

  return (
    <div className="eva-log" data-testid="chat-log" role="log" aria-live="off">
      <VList
        ref={ref}
        data={messages}
        style={{ height: '100%' }}
        onScroll={() => {
          const h = ref.current
          if (!h) return
          pinned.current = h.scrollSize - h.scrollOffset - h.viewportSize <= PIN_THRESHOLD
        }}
      >
        {(m) => <MessageRow key={m.id} m={m} />}
      </VList>
    </div>
  )
}
