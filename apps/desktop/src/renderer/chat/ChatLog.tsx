import {
  Profiler,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ProfilerOnRenderCallback,
} from 'react'
import { VList, type VListHandle } from 'virtua'
import type { ChatMessage } from '@evaos/chat-core/message'
import { dropQuietTurns } from '@evaos/chat-core/quiet'
import { MessageRow, ToolRunRow } from './MessageRow'
import { Pills } from './Pills'
import { pinReducer, type PinState } from './pin'
import { chatStore, useChatStore } from './chat-store'
import { startSettings, useSettings } from '../settings/settings-store'
import { TypingDots } from '../ui/TypingDots'

declare global {
  interface Window {
    /** e2e only: set to an array to collect Profiler commit durations (ms) of the log. */
    __evaosChatProfile?: number[]
  }
}

const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  window.__evaosChatProfile?.push(actualDuration)
}
type LogItem =
  | { kind: 'message'; m: ChatMessage }
  | { kind: 'tools'; tools: ChatMessage[] }
  | { kind: 'typing'; who: string }

/** Rows for the log: each message, or with `fold` each run of tool calls as one group. */
function logItems(list: ChatMessage[], fold: boolean): LogItem[] {
  const out: LogItem[] = []
  let run: ChatMessage[] = []
  const flush = (): void => {
    if (run.length > 0) out.push({ kind: 'tools', tools: run })
    run = []
  }
  for (const m of list) {
    if (fold && m.role === 'tool') run.push(m)
    else {
      flush()
      out.push({ kind: 'message', m })
    }
  }
  flush()
  return out
}

/**
 * Virtualized transcript. Follows the stream while pinned (within 24 px of the bottom), releases
 * on scroll-up without ever moving the scroll position, and re-pins on the pill or by scrolling
 * back down (CHAT-05, D-18). Scrolling is instant, never smooth.
 */
export function ChatLog({
  paneId,
  messages: all,
  file,
  typing = null,
}: {
  paneId: string
  messages: ChatMessage[]
  file: string
  /** An assistant thread's agent while it works: its three dots end the log until text streams. */
  typing?: string | null
}) {
  const showThinking = useSettings((s) => s.show_thinking)
  const showTools = useSettings((s) => s.show_tools)
  useEffect(() => {
    void startSettings()
  }, [])
  // Settings > Chat > Show thinking applies live: thinking rows are dropped, not collapsed.
  // Show tool details off folds each run of tool calls into one line (the Rust tool group).
  // Background turns answered "(nothing to report)" never show.
  const items = useMemo(() => {
    const shown = dropQuietTurns(all)
    const base = showThinking ? shown : shown.filter((m) => m.role !== 'thinking')
    const out = logItems(base, !showTools)
    const last = shown.at(-1)
    const streaming = last?.role === 'assistant' && last.streaming === true && last.text !== ''
    if (typing !== null && !streaming) out.push({ kind: 'typing', who: typing })
    return out
  }, [all, showThinking, showTools, typing])
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
    const last = items.length - 1
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
  }, [items])

  return (
    <div className="eva-log" data-testid="chat-log" role="log" aria-live="off">
      <Profiler id="chat-log" onRender={onRender}>
        <VList
          ref={ref}
          data={items}
          style={{ height: '100%' }}
          onScroll={() => {
            const h = ref.current
            if (!h) return
            dispatch({ type: 'scroll', gapPx: h.scrollSize - h.scrollOffset - h.viewportSize })
          }}
        >
          {(item) =>
            item.kind === 'tools' ? (
              <ToolRunRow key={`${item.tools[0]!.id}-tools`} tools={item.tools} />
            ) : item.kind === 'typing' ? (
              <div key="typing" className="eva-row" data-testid="chat-typing">
                <div className="eva-row-inner">
                  <TypingDots label={`${item.who} is typing`} />
                </div>
              </div>
            ) : (
              <MessageRow key={item.m.id} m={item.m} />
            )
          }
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
