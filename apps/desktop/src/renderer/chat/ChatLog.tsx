import { Profiler, useLayoutEffect, useRef, type ProfilerOnRenderCallback } from 'react'
import { VList, type VListHandle } from 'virtua'
import type { ChatMessage } from '@evaos/chat-core/message'
import { MessageRow } from './MessageRow'
import { Pills } from './Pills'
import { pinReducer, type PinState } from './pin'
import { chatStore, useChatStore } from './chat-store'

declare global {
  interface Window {
    /** e2e only: set to an array to collect Profiler commit durations (ms) of the log. */
    __evaosChatProfile?: number[]
  }
}

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  window.__evaosChatProfile?.push(actualDuration)
}

/**
 * Virtualized transcript. Follows the stream while pinned (within 24 px of the bottom), releases
 * on scroll-up without ever moving the scroll position, and re-pins on the pill or by scrolling
 * back down (CHAT-05, D-18). Scrolling is instant, never smooth.
 */
export function ChatLog({
  paneId,
  messages,
  file,
}: {
  paneId: string
  messages: ChatMessage[]
  file: string
}) {
  const ref = useRef<VListHandle>(null)
  const pin = useRef<PinState>({ pinned: true, newReply: false })
  const first = useRef(true)
  const unpinned = useChatStore((s) => s.panes[paneId]?.unpinned ?? false)
  const newReply = useChatStore((s) => s.panes[paneId]?.newReply ?? false)

  const dispatch = (ev: Parameters<typeof pinReducer>[1]): void => {
    const next = pinReducer(pin.current, ev)
    if (next === pin.current) return
    pin.current = next
    chatStore.getState().setPin(paneId, !next.pinned, next.newReply)
  }
  const toEnd = (): void => {
    const last = messages.length - 1
    if (last >= 0) ref.current?.scrollToIndex(last, { align: 'end' })
  }

  // Open at the end, once per opened file.
  useLayoutEffect(() => {
    dispatch({ type: 'jump' })
    toEnd()
    first.current = true
  }, [file])

  // Follow the stream while pinned; while released only flag new output and never touch scroll.
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (pin.current.pinned) toEnd()
    else dispatch({ type: 'output' })
  }, [messages])

  return (
    <div className="eva-log" data-testid="chat-log" role="log" aria-live="off">
      <Profiler id="chat-log" onRender={onRender}>
        <VList
          ref={ref}
          data={messages}
          style={{ height: '100%' }}
          onScroll={() => {
            const h = ref.current
            if (!h) return
            dispatch({ type: 'scroll', gapPx: h.scrollSize - h.scrollOffset - h.viewportSize })
          }}
        >
          {(m) => <MessageRow key={m.id} m={m} />}
        </VList>
      </Profiler>
      <Pills
        unpinned={unpinned}
        newReply={newReply}
        onJump={() => {
          dispatch({ type: 'jump' })
          toEnd()
        }}
      />
    </div>
  )
}
