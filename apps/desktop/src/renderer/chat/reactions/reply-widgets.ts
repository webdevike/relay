import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ThreadWidgets } from '@evaos/chat-core/reactions'

/**
 * Follow-up widgets under assistant replies: the ```openui block the host's widget agent picked
 * for a finished reply, by thread and reply reaction key (`widgets.snapshot`, which rides the
 * reactions views like bookmarks). A block that arrives after the thread's first snapshot here is
 * `arrived` (it slides in once); the ones a thread opens with just render. `training`: the host
 * takes 🎯 answers ("widget.training"), so picking 🎯 on a reply asks the one question.
 */
interface ReplyWidgetsState {
  threads: Record<string, ThreadWidgets>
  /** Reply keys of each thread whose block came live and has not finished sliding in. */
  arrived: Record<string, Record<string, true>>
  training: boolean
}

export const replyWidgetsStore = createStore<ReplyWidgetsState>(() => ({
  threads: {},
  arrived: {},
  training: false,
}))

/** The host's reply widgets of `thread` (null: it keeps none) and whether it takes 🎯 answers. */
export function applyHostWidgets(
  thread: string,
  widgets: ThreadWidgets | null,
  training: boolean,
): void {
  replyWidgetsStore.setState((s) => {
    if (widgets === null) {
      const { [thread]: _gone, ...threads } = s.threads
      const { [thread]: _done, ...arrived } = s.arrived
      return { threads, arrived, training }
    }
    const before = s.threads[thread]
    // The first snapshot of a thread is what it opens with: nothing slides in.
    const fresh =
      before === undefined ? [] : Object.keys(widgets).filter((k) => before[k] !== widgets[k])
    const live =
      fresh.length === 0 ? s.arrived : { ...s.arrived, [thread]: { ...s.arrived[thread] } }
    for (const k of fresh) live[thread]![k] = true
    return { threads: { ...s.threads, [thread]: widgets }, arrived: live, training }
  })
}

/** Reply `key`'s widget slid in: it renders still from now on (a remount does not replay it). */
export function settleReplyWidget(thread: string, key: string): void {
  const keys = replyWidgetsStore.getState().arrived[thread]
  if (keys?.[key] !== true) return
  const { [key]: _settled, ...rest } = keys
  replyWidgetsStore.setState((s) => ({ arrived: { ...s.arrived, [thread]: rest } }))
}

export function useReplyWidgets<T>(selector: (s: ReplyWidgetsState) => T): T {
  return useStore(replyWidgetsStore, selector)
}
