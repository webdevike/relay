// Private asks to Relay's assistants on a ticket (PLAN T4.2, DECISIONS 7). Each assistant has her
// own item session (`reviews.astraAsk` with her `agent` id), driven by `assistantAskMachine`; her
// replies render inside the Linear thread they were asked in (`askedIn`), or on their own in the
// activity. Nothing here is posted to Linear or GitHub.
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Button } from '@mantine/core'
import { useActorRef, useSelector } from '@xstate/react'
import { fromPromise, waitFor, type SnapshotFrom } from 'xstate'
import type { AstraItem, AstraTurn } from '@evaos/contract'
import { invoke } from '../ipc'
import { AstraThreadView, assistantName, useAstraItem } from '../reviews/AstraInline'
import { astraThreads, threadReplyText, type AstraThread } from '../reviews/astra-timeline'
import { askedIn } from './activity-model'
import {
  assistantAskMachine,
  type AskInput,
  type AskProgress,
  type SendResult,
} from './assistant-ask.machine'

/** Where an item session stands on its newest ask. */
export function progressOf(item: AstraItem): AskProgress {
  const lastAsk = item.turns.findLastIndex((t) => t.role === 'user')
  const answered = item.turns
    .slice(lastAsk + 1)
    .some((t) => t.role === 'assistant' && t.text.trim() !== '')
  return { working: item.working || item.waiting !== null, answered, error: item.error }
}

/** The text an ask sends: a follow-up names its thread. */
const askText = (a: AskInput): string => (a.thread ? threadReplyText(a.thread, a.text) : a.text)

type AskSnap = SnapshotFrom<typeof assistantAskMachine>

/** What the page shows of one assistant's asks. */
export type AskView =
  | { kind: 'idle' | 'sending' | 'answering' | 'answered' | 'restoring' }
  | { kind: 'failed'; message: string }
  | { kind: 'interrupted' }

const askView = (s: AskSnap): AskView =>
  s.matches('failed')
    ? { kind: 'failed', message: s.context.error ?? '' }
    : ({ kind: s.value } as AskView)

const sameView = (a: AskView, b: AskView): boolean => JSON.stringify(a) === JSON.stringify(b)

/** An ask on its way, as Isaac's turn in the right thread until her session has it. */
const pendingAsk = (s: AskSnap): string | null =>
  s.matches('sending') && s.context.ask ? askText(s.context.ask) : null

export interface AssistantSession {
  /** Her registry id (`astra`, `nova`). */
  agent: string
  name: string
  item: AstraItem | null
  threads: AstraThread[]
  view: AskView
  /** An ask is on its way. */
  sending: boolean
  /** She is working, waiting or failed, or an ask is on its way. */
  busy: boolean
  /** Asks in a new thread, or continues `thread` (its root's text); true once it reached her. */
  ask: (text: string, thread?: string) => Promise<boolean>
  retry: () => void
  dismiss: () => void
  /** Relay is back: the session's snapshot says where she is. */
  reconnect: () => void
}

interface SessionInput {
  url: string
  label: string
  context: () => string
}

/** One assistant's private session on the item, its asks run by `assistantAskMachine`. */
export function useAssistantSession(input: SessionInput, agent: string): AssistantSession {
  const astra = useAstraItem(input.url, agent)
  const live = useRef({ ...input, file: astra.item?.file ?? null })
  live.current = { ...input, file: astra.item?.file ?? null }
  const machine = useMemo(
    () =>
      assistantAskMachine.provide({
        actors: {
          send: fromPromise<SendResult, AskInput>(async ({ input: a }) => {
            const { url, label, context, file } = live.current
            const r = await invoke('reviews.astraAsk', {
              url,
              label,
              // Only the first ask seeds the session; later ones send the question alone.
              context: file ? '' : context(),
              text: askText(a),
              agent,
            })
            if (r.ok) return { kind: 'sent', progress: progressOf(r.value) }
            // No answer came back in time: it may have reached her.
            if (r.error.code === 'timeout') return { kind: 'lost' }
            return { kind: 'failed', message: r.error.message }
          }),
          restore: fromPromise<AskProgress | null, void>(async () => {
            const r = await invoke('reviews.astraThread', { url: live.current.url, agent })
            if (!r.ok) throw new Error(r.error.message)
            return r.value ? progressOf(r.value) : null
          }),
        },
      }),
    [agent],
  )
  const actor = useActorRef(machine)
  const view = useSelector(actor, askView, sameView)
  const pending = useSelector(actor, pendingAsk)

  useEffect(() => {
    if (!astra.item) return
    // Hearing from her session again means Relay is back.
    if (actor.getSnapshot().matches('interrupted')) actor.send({ type: 'ask.reconnected' })
    else actor.send({ type: 'ask.update', progress: progressOf(astra.item) })
  }, [actor, astra.item])
  useEffect(() => {
    const down = (): void => actor.send({ type: 'ask.disconnected' })
    const up = (): void => actor.send({ type: 'ask.reconnected' })
    window.addEventListener('offline', down)
    window.addEventListener('online', up)
    return () => {
      window.removeEventListener('offline', down)
      window.removeEventListener('online', up)
    }
  }, [actor])

  return useMemo(() => {
    const item = astra.item
    const turns: AstraTurn[] = [
      ...(item?.turns ?? []),
      ...(pending
        ? [
            {
              id: 'pending-ask',
              role: 'user' as const,
              text: pending,
              streaming: false,
              at: Date.now(),
            },
          ]
        : []),
    ]
    const working = item !== null && (item.working || item.waiting !== null || item.error !== null)
    const sending = view.kind === 'sending'
    return {
      agent,
      name: assistantName(agent),
      item,
      threads: astraThreads(turns, sending || working),
      view,
      sending,
      busy: sending || working,
      ask: async (text, thread) => {
        const event = thread
          ? ({ type: 'ask.followUp', text, thread } as const)
          : ({ type: 'ask.send', text } as const)
        if (!actor.getSnapshot().can(event)) return false
        actor.send(event)
        const s = await waitFor(actor, (x) => !x.matches('sending'))
        return !s.matches('failed')
      },
      retry: () => actor.send({ type: 'ask.retry' }),
      dismiss: () => actor.send({ type: 'ask.dismiss' }),
      reconnect: () => actor.send({ type: 'ask.reconnected' }),
    }
  }, [actor, agent, astra.item, pending, view])
}

/**
 * Every assistant's session on the item, in `ASSISTANTS` order (activity-model). One hook call
 * each, written out: hooks can't run in a loop.
 */
export function useAssistantSessions(input: SessionInput): AssistantSession[] {
  const astra = useAssistantSession(input, 'astra')
  const nova = useAssistantSession(input, 'nova')
  const penny = useAssistantSession(input, 'penny')
  const iris = useAssistantSession(input, 'iris')
  const polaris = useAssistantSession(input, 'polaris')
  return useMemo(() => [astra, nova, penny, iris, polaris], [astra, nova, penny, iris, polaris])
}

/** A private thread: her session's thread, Isaac's words shown without the thread it carried. */
export function AssistantReply({
  session,
  thread,
  now,
  me,
}: {
  session: AssistantSession
  thread: AstraThread
  now: number
  me: string
}) {
  const raw = thread.root.text
  const shown = { ...thread, root: { ...thread.root, text: askedIn(raw).text } }
  return (
    <div data-testid="assistant-reply" data-agent={session.agent}>
      <AstraThreadView
        thread={shown}
        item={session.item}
        newest={thread.newest === true}
        busy={session.busy}
        asking={session.sending}
        now={now}
        look="linear"
        me={me}
        agent={session.agent}
        // A reply in the thread continues it by the root's words as her session has them.
        onReply={(_, text) => session.ask(text, raw)}
      />
    </div>
  )
}

/** An ask that didn't go out, or a connection lost while she answered: what to do about it. */
export function AskNotices({ sessions }: { sessions: readonly AssistantSession[] }) {
  const rows: ReactNode[] = []
  for (const s of sessions) {
    if (s.view.kind !== 'failed' && s.view.kind !== 'interrupted') continue
    const failed = s.view.kind === 'failed'
    rows.push(
      <div
        key={s.agent}
        className="eva-tk-notice"
        role="status"
        data-kind={s.view.kind}
        data-testid="assistant-ask-notice"
      >
        <span className={failed ? 'eva-rv-error' : 'eva-rv-dim'}>
          {s.view.kind === 'failed'
            ? `${s.name}: ${s.view.message}`
            : `Connection lost while ${s.name} answered. Her reply shows when Relay is back.`}
        </span>
        <span className="eva-rv-spacer" />
        <Button size="compact-xs" variant="subtle" onClick={failed ? s.retry : s.reconnect}>
          {failed ? 'Retry' : 'Check again'}
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={s.dismiss}>
          Dismiss
        </Button>
      </div>,
    )
  }
  return rows.length > 0 ? <>{rows}</> : null
}
