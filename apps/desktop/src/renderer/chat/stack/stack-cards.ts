/**
 * The cards of a chat's stack on the composer, in order, from the chat's own data: the question the
 * session is blocked on (its live dialog), the assistant thread's open asks oldest first, then what
 * runs for the chat (its running subagents, then the assistant's other work in progress). Pure; the
 * stack's machine holds only the ids and which card is in front (`card-stack.machine.ts`).
 */
import type { OpenAsk } from '@evaos/contract'
import type { ActivityItem } from '@evaos/chat-core/activity'
import type { Dialog, Subagent } from '@evaos/chat-core/message'
import { cardModel, cardVendor, recentWork, type CardVendor } from '@evaos/chat-core/card-stack'
import { helperActivityId, subagentTranscriptFile } from '../../activity/eta'
import { subagentState } from '../strips/subagent-state'

/** The session's question or approval, answered through `chat.answerUi`. */
export interface DialogCard {
  kind: 'dialog'
  id: string
  title: string
  dialog: Dialog
}

/** An open ask of the assistant's thread. */
export interface AskCard {
  kind: 'ask'
  id: string
  title: string
  /** What the card says under its title; null when the title says it all. */
  detail: string | null
  ask: OpenAsk
}

/** Something in progress for the chat: a subagent, or a session, harness or canvas agent. */
export interface RunCard {
  kind: 'run'
  id: string
  title: string
  /** When it started (epoch ms); null when nothing says (a subagent without its helper run). */
  startedAt: number | null
  /** "Opus 5.5 high"; null when the source names no model. */
  model: string | null
  vendor: CardVendor | null
  /** Its recent work, oldest first. */
  log: string[]
  target: { to: 'subagent'; subagent: Subagent } | { to: 'activity'; item: ActivityItem }
}

export type StackCard = DialogCard | AskCard | RunCard

export interface StackSources {
  /** The session's live dialog (a dead one gets no card). */
  dialog: Dialog | null
  /** The thread's open asks. */
  asks: readonly OpenAsk[]
  subagents: readonly Subagent[]
  /** The chat's session file, which names where its subagents' transcripts live. */
  sessionFile: string
  /** The host's whole activity list: a subagent finds its helper run here. */
  activity: readonly ActivityItem[]
  /** The assistant's other work in progress (no helpers). */
  spunOff: readonly ActivityItem[]
  now: number
}

/** The id a session dialog's card gets. */
export const dialogCardId = (dialogId: string): string => `dialog:${dialogId}`

/** A dialog's title: the question asked, or the request's title. */
export function dialogTitle(d: Dialog): string {
  return d.kind === 'ask' ? (d.questions[0]?.question ?? '') : d.title
}

/**
 * An "ask" card the thread lists for the session's live dialog: a session blocked on omp's ask shows
 * its dialog as `ask:<askId>` (main/chat/remote.ts `blockerDialog`), so the card is not doubled.
 */
export function mirrorsDialog(ask: OpenAsk, dialog: Dialog | null): boolean {
  return (
    dialog !== null &&
    ask.source === 'ask' &&
    ask.askId !== undefined &&
    dialog.id === `ask:${ask.askId}`
  )
}

/** What a session ask does when Isaac does not answer; null when it names no default among its answers. */
export function defaultNote(ask: OpenAsk): string | null {
  return ask.default !== undefined && ask.replies.includes(ask.default)
    ? `Going with ${ask.default} unless you say otherwise.`
    : null
}

/** An ask card's line under its title: the question when the label does not already say it, and the default. */
export function askDetail(ask: OpenAsk): string | null {
  const question = ask.question.trim() === ask.label.trim() ? null : ask.question
  const parts = [question, defaultNote(ask)].filter((p): p is string => p !== null && p !== '')
  return parts.length === 0 ? null : parts.join(' ')
}

function activityRun(id: string, title: string, item: ActivityItem): Omit<RunCard, 'target'> {
  return {
    kind: 'run',
    id,
    title,
    startedAt: item.startedAt,
    model: cardModel(item.model, item.thinking),
    vendor: cardVendor(item.model, item.vendor),
    log: recentWork(item),
  }
}

export function stackCards(src: StackSources): StackCard[] {
  const cards: StackCard[] = []
  if (src.dialog !== null) {
    cards.push({
      kind: 'dialog',
      id: dialogCardId(src.dialog.id),
      title: dialogTitle(src.dialog),
      dialog: src.dialog,
    })
  }
  for (const ask of [...src.asks].sort((a, b) => a.at - b.at)) {
    if (mirrorsDialog(ask, src.dialog)) continue
    cards.push({ kind: 'ask', id: `ask:${ask.id}`, title: ask.label, detail: askDetail(ask), ask })
  }
  for (const s of src.subagents) {
    if (subagentState(s, src.now) !== 'running') continue
    const id = `sub:${s.name}`
    const target = { to: 'subagent' as const, subagent: s }
    const runId = helperActivityId(subagentTranscriptFile(src.sessionFile, s.file))
    const item = src.activity.find((i) => i.id === runId)
    cards.push(
      item === undefined
        ? {
            kind: 'run',
            id,
            title: s.name,
            startedAt: null,
            model: null,
            vendor: null,
            log: s.lastLine === '' ? [] : [s.lastLine],
            target,
          }
        : { ...activityRun(id, s.name, item), target },
    )
  }
  for (const item of src.spunOff) {
    cards.push({
      ...activityRun(`run:${item.id}`, item.title, item),
      target: { to: 'activity', item },
    })
  }
  return cards
}
