// Blocking omp UI requests as typed dialogs, and the extension_ui_response frames that answer
// them. Ported from Rust chat.rs (Live::ui_request, Dialog::response) and relay.rs Ask::parse.
// All text stays plain strings; renderers show text only.

export type DialogOption = { label: string; description?: string }
export type AskQuestion = {
  id: string
  question: string
  header?: string
  options: DialogOption[]
  recommended?: number
  multi: boolean
}
export type Dialog =
  | { kind: 'select'; id: string; title: string; options: DialogOption[] }
  | { kind: 'confirm'; id: string; title: string; message: string }
  | { kind: 'input'; id: string; title: string; placeholder?: string }
  | { kind: 'editor'; id: string; title: string; placeholder?: string; prefill?: string }
  | { kind: 'ask'; id: string; questions: AskQuestion[] }

export type DialogParse =
  { dialog: Dialog } | { unreadable: { id: string } } | { cancelTarget: string } | null

export type DialogAnswer =
  | { kind: 'select'; value: string }
  | { kind: 'confirm'; confirmed: boolean }
  | { kind: 'text'; value: string }
  | {
      kind: 'ask'
      answers: Array<{ id: string; picked: string[] } | { id: string; typed: string }>
    }
  | { kind: 'cancel' }

export const UNREADABLE_ASK_NOTICE =
  "omp asked a question Relay couldn't read, so it was cancelled."

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseAsk(frame: Record<string, unknown>): AskQuestion[] | null {
  if (!Array.isArray(frame.questions)) return null
  const questions: AskQuestion[] = []
  for (const q of frame.questions as unknown[]) {
    if (!isRecord(q) || !Array.isArray(q.options)) continue
    const options: DialogOption[] = []
    for (const o of q.options as unknown[]) {
      if (!isRecord(o)) continue
      const label = nonEmpty(o.label)
      if (label === undefined) continue
      const description = nonEmpty(o.description)
      options.push(description === undefined ? { label } : { label, description })
    }
    const qid = nonEmpty(q.id)
    const text = nonEmpty(q.question)
    if (qid === undefined || text === undefined || options.length === 0) continue
    const out: AskQuestion = { id: qid, question: text, options, multi: q.multi === true }
    const header = nonEmpty(q.header)
    if (header !== undefined) out.header = header
    const rec = q.recommended
    if (typeof rec === 'number' && Number.isInteger(rec) && rec >= 0 && rec < options.length) {
      out.recommended = rec
    }
    questions.push(out)
  }
  return questions.length > 0 ? questions : null
}

export function parseDialog(frame: Record<string, unknown>): DialogParse {
  const id = nonEmpty(frame.id)
  if (id === undefined) return null
  const title = typeof frame.title === 'string' ? frame.title : 'omp is asking'
  switch (frame.method) {
    case 'select': {
      const raw = Array.isArray(frame.options) ? (frame.options as unknown[]) : []
      const details = Array.isArray(frame.optionDetails) ? (frame.optionDetails as unknown[]) : []
      const options: DialogOption[] = []
      raw.forEach((o, ix) => {
        if (typeof o !== 'string') return
        const d = details[ix]
        const description = isRecord(d) ? nonEmpty(d.description) : undefined
        options.push(description === undefined ? { label: o } : { label: o, description })
      })
      return { dialog: { kind: 'select', id, title, options } }
    }
    case 'confirm':
      return {
        dialog: {
          kind: 'confirm',
          id,
          title,
          message: typeof frame.message === 'string' ? frame.message : '',
        },
      }
    case 'input':
    case 'editor': {
      const placeholder = nonEmpty(frame.placeholder)
      if (frame.method === 'input') {
        const d: Dialog = { kind: 'input', id, title }
        if (placeholder !== undefined) d.placeholder = placeholder
        return { dialog: d }
      }
      const d: Dialog = { kind: 'editor', id, title }
      if (placeholder !== undefined) d.placeholder = placeholder
      const prefill = nonEmpty(frame.prefill)
      if (prefill !== undefined) d.prefill = prefill
      return { dialog: d }
    }
    case 'ask': {
      const questions = parseAsk(frame)
      return questions === null
        ? { unreadable: { id } }
        : { dialog: { kind: 'ask', id, questions } }
    }
    case 'cancel': {
      const target = nonEmpty(frame.targetId)
      return target === undefined ? null : { cancelTarget: target }
    }
    default:
      return null
  }
}

export function dialogResponse(id: string, answer: DialogAnswer): Record<string, unknown> {
  const type = 'extension_ui_response'
  switch (answer.kind) {
    case 'select':
      return { type, id, value: answer.value }
    case 'confirm':
      return { type, id, confirmed: answer.confirmed }
    case 'text':
      return { type, id, value: answer.value }
    case 'ask':
      return {
        type,
        id,
        answers: answer.answers.map((a) =>
          'typed' in a
            ? { id: a.id, selectedOptions: [], customInput: a.typed }
            : { id: a.id, selectedOptions: a.picked },
        ),
      }
    case 'cancel':
      return { type, id, cancelled: true }
  }
}

export function dialogStatus(d: Dialog): 'confirm' | 'other' {
  return d.kind === 'confirm' ? 'confirm' : 'other'
}

const oneLined = (t: string, max: number): string => {
  const flat = t.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) : flat
}

/** The summary of a question the user dismissed: its log row reads just `Skipped`. */
export const SKIPPED = 'Skipped'

/** The log row text for a settled dialog: `Answered: {summary}`, or `Skipped`. */
export function answerRowText(summary: string): string {
  return summary === SKIPPED ? SKIPPED : `Answered: ${summary}`
}

/**
 * What the log row shows after the user answered: `Answered: {summary}`. A cancel of a question
 * card (`select` or `ask`, pass its kind) is `Skipped`; a declined confirm stays `Declined`.
 */
export function answerSummary(a: DialogAnswer, dialogKind?: Dialog['kind']): string {
  switch (a.kind) {
    case 'select':
      return a.value
    case 'confirm':
      return a.confirmed ? 'Confirm' : 'Declined'
    case 'text':
      return oneLined(a.value, 80)
    case 'cancel':
      return dialogKind === 'select' || dialogKind === 'ask' ? SKIPPED : 'Declined'
    case 'ask': {
      const parts = a.answers.flatMap((x) => ('typed' in x ? [x.typed] : x.picked))
      return oneLined(parts.join(', '), 160) || 'Declined'
    }
  }
}
