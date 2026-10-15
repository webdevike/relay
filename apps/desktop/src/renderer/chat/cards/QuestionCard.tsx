import { useRef, useState } from 'react'
import type { AskQuestion, Dialog } from '@evaos/chat-core/message'
import type { DialogResponse } from '@evaos/contract'
import { useQuestionHotkeys } from './useQuestionHotkeys'

type Choice = Extract<Dialog, { kind: 'select' | 'ask' }>

const HOTKEYS = 4

function questionsOf(d: Choice): AskQuestion[] {
  if (d.kind === 'ask') return d.questions
  return [{ id: d.id, question: d.title, options: d.options, multi: false }]
}

function respond(d: Choice, qs: AskQuestion[], picks: string[][]): DialogResponse {
  if (d.kind === 'select') return { kind: 'select', value: picks[0]![0]! }
  return { kind: 'ask', answers: qs.map((q, i) => ({ id: q.id, picked: picks[i]! })) }
}

/** Blocked `ask` and extension `select` requests: numbered single or multi choice options. */
export function QuestionCard({
  dialog,
  dead = false,
  onAnswer,
}: {
  dialog: Choice
  dead?: boolean
  onAnswer: (response: DialogResponse) => void | Promise<boolean>
}) {
  const qs = questionsOf(dialog)
  const [picks, setPicks] = useState<string[][]>(() => qs.map(() => []))
  const sent = useRef(false)
  // One lone single-choice question answers on click; anything else waits for Send answer.
  const immediate = qs.length === 1 && !qs[0]!.multi
  const firstOpen = picks.findIndex((p) => p.length === 0)
  const complete = firstOpen < 0

  const submit = (next: string[][]): void => {
    if (sent.current || dead) return
    sent.current = true
    // A failed or stale answer re-arms the card so the user can try again.
    void Promise.resolve(onAnswer(respond(dialog, qs, next))).then((ok) => {
      if (ok === false) sent.current = false
    })
  }

  const choose = (qi: number, label: string): void => {
    if (dead || sent.current) return
    const q = qs[qi]!
    const cur = picks[qi]!
    const nextQ = q.multi
      ? cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label]
      : [label]
    const next = picks.map((p, i) => (i === qi ? nextQ : p))
    setPicks(next)
    if (immediate) submit(next)
  }

  useQuestionHotkeys(!dead, (index) => {
    if (sent.current || firstOpen < 0) return false
    const label = qs[firstOpen]!.options[index]?.label
    if (label === undefined) return false
    choose(firstOpen, label)
    return true
  })

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    )
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    const to = e.key === 'ArrowDown' ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0)
    items[to]?.focus()
  }

  return (
    <div
      className="eva-question"
      data-testid="pending-dialog"
      data-dead={dead ? 'true' : undefined}
    >
      {qs.map((q, qi) => (
        <div key={q.id} className="eva-question-block">
          {q.header ? <h3 className="eva-heading eva-question-header">{q.header}</h3> : null}
          <div className="eva-question-text">{q.question}</div>
          <div
            role="radiogroup"
            aria-label={q.question}
            className="eva-question-options"
            onKeyDown={onKeyDown}
          >
            {q.options.map((o, oi) => {
              const on = picks[qi]!.includes(o.label)
              const chip = qi === (complete ? -1 : firstOpen) && oi < HOTKEYS && !dead
              return (
                <button
                  key={`${oi}-${o.label}`}
                  type="button"
                  role={q.multi ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  disabled={dead}
                  className="eva-question-option"
                  data-selected={on ? 'true' : undefined}
                  onClick={() => choose(qi, o.label)}
                >
                  {chip ? (
                    <kbd className="eva-kbd">{oi + 1}</kbd>
                  ) : (
                    <span className="eva-kbd-gap" />
                  )}
                  <span className="eva-question-label">{o.label}</span>
                  {o.description ? (
                    <span className="eva-dim eva-question-desc">{o.description}</span>
                  ) : null}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {!immediate && !dead ? (
        <div className="eva-question-actions">
          <button
            type="button"
            className="eva-card-button"
            disabled={!complete}
            onClick={() => submit(picks)}
          >
            Send answer
          </button>
        </div>
      ) : null}
      {dead ? (
        <div className="eva-label eva-dim eva-question-caption">
          This question can no longer be answered.
        </div>
      ) : null}
    </div>
  )
}
