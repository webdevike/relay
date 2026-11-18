import {
  Profiler,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ProfilerOnRenderCallback,
} from 'react'
import { VList, type VListHandle } from 'virtua'
import type { ChatMessage } from '@evaos/chat-core/message'
import { dropQuietTurns } from '@evaos/chat-core/quiet'
import { foldGuestWork, guestTyping } from '@evaos/chat-core/guest-entry'
import { reactionKeyOf } from '@evaos/chat-core/reactions'
import { registerReveal } from '../pins/pins-scope'
import { useRailFits } from '../pins/PinsRail'
import { MessageRow, ToolRunRow } from './MessageRow'
import { ReactionScope, useReactions } from './reactions/reactions-store'
import { TurnMinimap, turnRailFits } from './minimap/TurnMinimap'
import { buildTurns, type Turn } from '@evaos/chat-core/turns'
import { turnRows } from './minimap/rows'
import { askAgentOf, resolveAsk, useOpenAsks } from './asks/asks-store'
import { askRow, looseAsks, waitingRows, waitingTurns } from './asks/open-asks'
import { jumpToAsk, registerAskJump } from './asks/ask-jump'
import { Pills } from './Pills'
import { pinReducer, type PinState } from './pin'
import { chatStore, useChatStore } from './chat-store'
import {
  chatScrollOf,
  rememberChatScroll,
  takeChatScrollRequest,
  type ChatScroll,
} from './chat-scroll'
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
export type LogItem =
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
 * The row tap-to-answer replies may show under: the log's last row when it is a reply done
 * streaming (no typing dots, tool call or prompt, sent or still unconfirmed, after it), while the
 * chat is not `busy` with a turn. Null otherwise.
 */
export function liveRowId(items: LogItem[], busy: boolean): string | null {
  if (busy) return null
  const last = items.at(-1)
  if (last?.kind !== 'message') return null
  return last.m.role === 'assistant' && !last.m.streaming ? last.m.id : null
}

/** Frames a restore keeps putting the log back while the list measures its rows. */
const RESTORE_FRAMES = 20

/**
 * Virtualized transcript. Follows the stream while pinned (within 24 px of the bottom), releases
 * on scroll-up without ever moving the scroll position, and re-pins on the pill or by scrolling
 * back down (CHAT-05, D-18). Scrolling is instant, never smooth. A chat opens at the end; one
 * shown again after another page (or brought back by Back to chat) is where Isaac left it.
 */
export function ChatLog({
  paneId,
  messages: all,
  file,
  scrollFile = file,
  shown = true,
  typing = null,
  busy = false,
}: {
  paneId: string
  messages: ChatMessage[]
  /** The log's key: a new one opens at the end. */
  file: string
  /** The session file the scroll position is remembered under. */
  scrollFile?: string
  /** The pane is on screen (it stays mounted, hidden, while another page shows). */
  shown?: boolean
  /** An assistant thread's agent while it works: its three dots end the log until text streams. */
  typing?: string | null
  /** The chat is in a turn: no tap-to-answer replies show. */
  busy?: boolean
}) {
  const showThinking = useSettings((s) => s.show_thinking)
  const showTools = useSettings((s) => s.show_tools)
  useEffect(() => {
    void startSettings()
  }, [])
  // Settings > Chat > Show thinking applies live: thinking rows are dropped, not collapsed.
  // Show tool details off folds each run of tool calls into one line (the Rust tool group).
  // Background turns answered "(nothing to report)" never show. Each piece of work another
  // assistant took on is one card (its latest state, where it started); a guest that joined and
  // has not spoken yet shows typing.
  const items = useMemo(() => {
    const kept = dropQuietTurns(foldGuestWork(all))
    const base = showThinking ? kept : kept.filter((m) => m.role !== 'thinking')
    const out = logItems(base, !showTools)
    const last = kept.at(-1)
    const streaming = last?.role === 'assistant' && last.streaming === true && last.text !== ''
    const who = guestTyping(kept)?.title ?? typing
    if (who !== null && !streaming) out.push({ kind: 'typing', who })
    return out
  }, [all, showThinking, showTools, typing])
  const liveId = liveRowId(items, busy)
  const ref = useRef<VListHandle>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const railFits = useRailFits(logRef, turnRailFits)
  const pin = useRef<PinState>({ pinned: true, newReply: false })
  const first = useRef(true)
  /** The file and visibility the last layout pass handled. */
  const seen = useRef<{ file: string | null; shown: boolean }>({ file: null, shown })
  const restoring = useRef(0)
  const unpinned = useChatStore((s) => s.panes[paneId]?.unpinned ?? false)
  const newReply = useChatStore((s) => s.panes[paneId]?.newReply ?? false)

  const dispatch = (ev: Parameters<typeof pinReducer>[1]): void => {
    const next = pinReducer(pin.current, ev)
    if (next === pin.current) return
    pin.current = next
    chatStore.getState().setPin(paneId, !next.pinned, next.newReply)
  }
  const toEnd = (): void => {
    restoring.current += 1
    const last = items.length - 1
    if (last >= 0) ref.current?.scrollToIndex(last, { align: 'end' })
  }
  /** The end when `s` followed it, else its offset, put back each frame until the rows measured. */
  const applyScroll = (s: ChatScroll): void => {
    if (s.pinned) {
      dispatch({ type: 'jump' })
      toEnd()
      return
    }
    pin.current = { ...pin.current, pinned: false }
    chatStore.getState().setPin(paneId, true, pin.current.newReply)
    const token = ++restoring.current
    let frames = 0
    const step = (): void => {
      const h = ref.current
      if (token !== restoring.current || !h) return
      h.scrollTo(s.offset)
      frames += 1
      if (Math.abs(h.scrollOffset - s.offset) > 1 && frames < RESTORE_FRAMES)
        requestAnimationFrame(step)
    }
    step()
  }

  // A chat comes back where Isaac left it, even mounted anew (its workspace shown again, or a
  // return asked for an exact place); one never seen this session starts at the end.
  useLayoutEffect(() => {
    const prev = seen.current
    seen.current = { file, shown }
    if (prev.file !== file) {
      const asked = takeChatScrollRequest(scrollFile) ?? chatScrollOf(scrollFile)
      if (asked) applyScroll(asked)
      else {
        dispatch({ type: 'jump' })
        toEnd()
      }
      first.current = true
      return
    }
    if (!shown || prev.shown) return
    const back = takeChatScrollRequest(scrollFile) ?? chatScrollOf(scrollFile)
    if (back) applyScroll(back)
    else if (pin.current.pinned) toEnd()
  }, [file, shown])

  // Follow the stream while pinned; while released only flag new output and never touch scroll.
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (pin.current.pinned) toEnd()
    else dispatch({ type: 'output' })
  }, [items])

  // Replies appear under the last row once the turn is over (often after its last text): a pinned
  // log keeps them in view.
  useLayoutEffect(() => {
    if (liveId !== null && pin.current.pinned) toEnd()
  }, [liveId])

  /** Brings log row `at` (message `id`) into view at `align` and flashes it briefly. */
  const revealRow = (at: number, id: string, align: 'start' | 'center'): void => {
    ref.current?.scrollToIndex(at, { align })
    // The row mounts after the list scrolls to it.
    let tries = 0
    const flash = (): void => {
      const row = document.querySelector<HTMLElement>(`[data-testid="msg-${CSS.escape(id)}"]`)
      if (row === null) {
        if (++tries < 20) requestAnimationFrame(flash)
        return
      }
      row.dataset['flash'] = 'true'
      window.setTimeout(() => delete row.dataset['flash'], 1500)
    }
    requestAnimationFrame(flash)
  }

  // A pin's label brings its source message (by bubble key) into view and flashes it briefly.
  useEffect(
    () =>
      registerReveal(paneId, (key) => {
        const at = items.findIndex((i) => i.kind === 'message' && reactionKeyOf(i.m) === key)
        const item = items[at]
        if (item?.kind !== 'message') return false
        revealRow(at, item.m.id, 'center')
        return true
      }),
    [paneId, items],
  )

  // The turn navigator: its ticks, and the jump a click or Alt+Up/Down makes.
  const thread = useContext(ReactionScope)?.thread ?? null
  const reactions = useReactions((s) => (thread === null ? undefined : s.threads[thread]))
  const rows = useMemo(() => [...turnRows(items)], [items])
  const turns = useMemo(() => buildTurns(rows, reactions), [rows, reactions])
  // Open asks (assistant threads): the bubbles that carry one, the turns they sit in, the ones with
  // no bubble, and the jump to a bubble.
  const agent = askAgentOf(thread)
  const asks = useOpenAsks(agent)
  const waiting = useMemo(() => waitingRows(rows, asks), [rows, asks])
  const waitingByTurn = useMemo(() => waitingTurns(turns, rows, asks), [turns, rows, asks])
  const loose = useMemo(() => looseAsks(rows, asks), [rows, asks])
  useEffect(
    () =>
      registerAskJump(paneId, (ask) => {
        const row = askRow(rows, ask)
        if (row === null) return false
        // A restore still putting the log back must not undo the jump.
        restoring.current += 1
        revealRow(row.index, row.id, 'center')
        return true
      }),
    [paneId, rows],
  )
  const scrollWatchers = useRef(new Set<() => void>())
  const watchScroll = useCallback((fn: () => void) => {
    scrollWatchers.current.add(fn)
    return () => void scrollWatchers.current.delete(fn)
  }, [])
  const jumpToTurn = (turn: Turn): void => {
    // A restore still putting the log back must not undo the jump.
    restoring.current += 1
    revealRow(turn.item, turn.row, 'start')
  }

  return (
    <div className="eva-log" data-testid="chat-log" role="log" aria-live="off" ref={logRef}>
      <Profiler id="chat-log" onRender={onRender}>
        <VList
          ref={ref}
          data={items}
          style={{ height: '100%' }}
          onScroll={() => {
            for (const fn of scrollWatchers.current) fn()
            const h = ref.current
            // Hidden, the list has no size: what it reports is not where Isaac left it.
            if (!h || !seen.current.shown || h.viewportSize === 0) return
            dispatch({ type: 'scroll', gapPx: h.scrollSize - h.scrollOffset - h.viewportSize })
            rememberChatScroll(scrollFile, { offset: h.scrollOffset, pinned: pin.current.pinned })
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
              <MessageRow
                key={item.m.id}
                m={item.m}
                live={item.m.id === liveId}
                waiting={waiting.get(item.m.id)}
                agent={agent ?? undefined}
              />
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
      <TurnMinimap
        turns={turns}
        waiting={waitingByTurn}
        loose={loose}
        onJumpAsk={(ask) => jumpToAsk(paneId, ask)}
        onResolveAsk={(ask, how, answer) => {
          if (agent !== null) void resolveAsk(agent, ask, how, answer)
        }}
        thread={thread ?? `file:${scrollFile}`}
        paneId={paneId}
        listRef={ref}
        subscribe={watchScroll}
        jump={jumpToTurn}
        shown={shown}
        fits={railFits}
      />
    </div>
  )
}
