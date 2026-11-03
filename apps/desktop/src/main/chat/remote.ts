// What the chat pane shows of a session omp runs outside this app (a terminal, a job, herdr), read
// from its session file and driven through Relay: native chat_view.rs's past chat with the Relay
// stream row, the question card and the `Starting omp in herdr` row.
import { answerSummary, type DialogAnswer } from '@evaos/chat-core/dialogs'
import { makeMessage, type ChatMessage, type Dialog } from '@evaos/chat-core/message'
import { answerCommand, decideCommand, type RelayCommand, type RelayImage } from '../relay/commands'
import type { RelayApproval, RelayAsk } from '../relay/feed'

export const STARTING_TEXT = 'Starting omp in herdr'
export const MINI_STARTING_TEXT = 'Starting omp on the Mini'
export const STARTING_ROW = 'herdr-starting'
export const STREAM_ROW = 'relay-stream'

/** The text so far of the reply a subscribed session is streaming. */
export interface Stream {
  id: string
  text: string
  streaming: boolean
}

/** A prompt sent through Relay (or waiting to be), shown until the session file has it. */
export interface SentPrompt {
  row: ChatMessage
  /** How many of the file's prompts had this text when it was sent. */
  baseline: number
  /** Still to send: a new herdr chat's prompt before its omp joined Relay (surface-tagged). */
  queued?: { text: string; images: RelayImage[] }
}

/** A question or tool approval a session is blocked on, as Relay sent it. */
export type Blocker = { kind: 'ask'; ask: RelayAsk } | { kind: 'approval'; approval: RelayApproval }

export interface RemoteView {
  /** The session file's transcript. */
  history: ChatMessage[]
  /** Rows only this app shows until the file moves on: questions answered here. */
  notes: ChatMessage[]
  dialog: Dialog | null
  prompts: readonly SentPrompt[]
  /** The row's text while herdr or the Mini starts omp, or its first prompt waits for omp to join Relay. */
  starting: string | null
  stream: Stream | null
}

/** How many prompts in `history` read `text`. */
export function promptCount(history: readonly ChatMessage[], text: string): number {
  const key = text.trim()
  return history.filter((m) => m.role === 'user' && m.text.trim() === key).length
}

/**
 * The streamed reply shows until the session file has it: while it streams, and after that until
 * the file's last reply reads the same (native's relay-stream row).
 */
export function streamShown(stream: Stream | null, history: readonly ChatMessage[]): boolean {
  if (stream === null || stream.text === '') return false
  if (stream.streaming) return true
  const last = history.findLast((m) => m.role === 'assistant')
  return last === undefined || last.text.trim() !== stream.text.trim()
}

/** The rows a session read through Relay shows: its file, then what only this app knows yet. */
export function remoteRows(v: RemoteView): ChatMessage[] {
  const rows = [...v.history, ...v.notes]
  if (v.dialog) rows.push(makeMessage(dialogRowId(v.dialog.id), 'notice', dialogTitle(v.dialog)))
  for (const p of v.prompts) rows.push(p.row)
  if (v.starting !== null) rows.push(makeMessage(STARTING_ROW, 'notice', v.starting))
  if (v.stream && streamShown(v.stream, v.history)) {
    rows.push(
      makeMessage(STREAM_ROW, 'assistant', v.stream.text, { streaming: v.stream.streaming }),
    )
  }
  return rows
}

export function dialogRowId(dialogId: string): string {
  return `dialog-${dialogId}`
}

function dialogTitle(d: Dialog): string {
  return d.kind === 'ask' ? d.questions.map((q) => q.question).join(' / ') : d.title
}

/** The card a blocked session shows: an ask's questions, or an approval to confirm. */
export function blockerDialog(b: Blocker): Dialog {
  if (b.kind === 'ask') {
    return {
      kind: 'ask',
      id: `ask:${b.ask.id}`,
      questions: b.ask.questions.map((q) => ({
        id: q.id,
        question: q.question,
        ...(q.header !== null ? { header: q.header } : {}),
        options: q.options.map((o) =>
          o.description !== null
            ? { label: o.label, description: o.description }
            : { label: o.label },
        ),
        ...(q.recommended !== null ? { recommended: q.recommended } : {}),
        multi: q.multi,
      })),
    }
  }
  const a = b.approval
  const lines = [a.command, a.reason, a.destructive ? `Destructive: ${a.destructive}` : null]
  return {
    kind: 'confirm',
    id: `approval:${a.id}`,
    title: `${a.tool} needs approval`,
    message: lines.filter((l): l is string => l !== null && l !== '').join('\n'),
  }
}

/**
 * The command that answers `b` the way the card was answered, and what its row says after: an
 * ask's picks, typed text or cancel; an approval's confirm (approve) or decline (deny). Null for an
 * answer that does not fit the card.
 */
export function answerFor(
  session: string,
  b: Blocker,
  answer: DialogAnswer,
): { cmd: RelayCommand; summary: string } | null {
  if (b.kind === 'ask') {
    if (answer.kind === 'ask') {
      return {
        cmd: answerCommand(session, b.ask.id, answer.answers),
        summary: answerSummary(answer),
      }
    }
    if (answer.kind === 'cancel') {
      return {
        cmd: { kind: 'agent.ask.cancel', sessionId: session, askId: b.ask.id },
        summary: answerSummary(answer),
      }
    }
    return null
  }
  const allow = answer.kind === 'confirm' && answer.confirmed
  if (answer.kind !== 'confirm' && answer.kind !== 'cancel') return null
  return {
    cmd: decideCommand(session, b.approval.id, allow),
    summary: allow ? 'Approved' : 'Denied',
  }
}
