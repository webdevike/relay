import { useRef, useState } from 'react'
import {
  Box,
  Button,
  Group,
  Kbd,
  Paper,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core'
import { IconArrowLeft, IconArrowRight, IconCheck } from '@tabler/icons-react'
import type { AskQuestion, Dialog } from '@evaos/chat-core/message'
import type { DialogResponse } from '@evaos/contract'
import { useQuestionHotkeys } from './useQuestionHotkeys'

type Choice = Extract<Dialog, { kind: 'select' | 'ask' }>

const HOTKEYS = 4

function questionsOf(d: Choice): AskQuestion[] {
  if (d.kind === 'ask') return d.questions
  return [{ id: d.id, question: d.title, options: d.options, multi: false }]
}

/** A typed answer wins over picked options for that question. */
function respond(d: Choice, qs: AskQuestion[], picks: string[][], typed: string[]): DialogResponse {
  if (d.kind === 'select') return { kind: 'select', value: picks[0]![0]! }
  return {
    kind: 'ask',
    answers: qs.map((q, i) => {
      const text = typed[i]!.trim()
      return text ? { id: q.id, typed: text } : { id: q.id, picked: picks[i]! }
    }),
  }
}

/**
 * Blocked `ask` and extension `select` requests: one page per question, numbered single or multi
 * choice options, and (for `ask`) a free-form answer that replaces the options.
 */
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
  const freeForm = dialog.kind === 'ask'
  const [picks, setPicks] = useState<string[][]>(() => qs.map(() => []))
  const [typed, setTyped] = useState<string[]>(() => qs.map(() => ''))
  const [page, setPage] = useState(0)
  const sent = useRef(false)
  // One lone single-choice question answers on click; anything else waits for Send answer.
  const immediate = qs.length === 1 && !qs[0]!.multi
  const answered = (i: number): boolean => picks[i]!.length > 0 || typed[i]!.trim() !== ''
  const complete = qs.every((_, i) => answered(i))
  const last = page === qs.length - 1
  const q = qs[page]!
  const text = typed[page]!

  const submit = (nextPicks: string[][], nextTyped = typed): void => {
    if (sent.current || dead) return
    sent.current = true
    // A failed or stale answer re-arms the card so the user can try again.
    void Promise.resolve(onAnswer(respond(dialog, qs, nextPicks, nextTyped))).then((ok) => {
      if (ok === false) sent.current = false
    })
  }

  const choose = (qi: number, label: string): void => {
    if (dead || sent.current) return
    const cur = picks[qi]!
    const nextQ = qs[qi]!.multi
      ? cur.includes(label)
        ? cur.filter((l) => l !== label)
        : [...cur, label]
      : [label]
    const next = picks.map((p, i) => (i === qi ? nextQ : p))
    const nextTyped = typed.map((t, i) => (i === qi ? '' : t))
    setPicks(next)
    setTyped(nextTyped)
    if (immediate) submit(next, nextTyped)
    // A single choice on a middle page moves on to the next question.
    else if (!qs[qi]!.multi && !last) setPage(qi + 1)
  }

  const type = (value: string): void => {
    setTyped(typed.map((t, i) => (i === page ? value : t)))
    if (value.trim()) setPicks(picks.map((p, i) => (i === page ? [] : p)))
  }

  const advance = (): void => {
    if (!answered(page)) return
    if (!last) setPage(page + 1)
    else if (complete) submit(picks)
  }

  useQuestionHotkeys(!dead, (index) => {
    if (sent.current) return false
    const label = q.options[index]?.label
    if (label === undefined) return false
    choose(page, label)
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

  const showActions = !dead && (!immediate || text.trim() !== '')

  return (
    <Paper
      withBorder
      radius="lg"
      p="md"
      className="eva-question"
      data-testid="pending-dialog"
      data-dead={dead ? 'true' : undefined}
    >
      <Stack gap="sm">
        {q.header || qs.length > 1 ? (
          <Group justify="space-between" gap="xs">
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              {q.header ?? ''}
            </Text>
            {qs.length > 1 ? (
              <Text size="xs" c="dimmed">
                {page + 1} of {qs.length}
              </Text>
            ) : null}
          </Group>
        ) : null}
        <Text fw={500} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {q.question}
        </Text>
        <Stack
          key={q.id}
          gap="xs"
          role={q.multi ? 'group' : 'radiogroup'}
          aria-label={q.question}
          onKeyDown={onKeyDown}
        >
          {q.options.map((o, oi) => {
            const on = picks[page]!.includes(o.label)
            return (
              <UnstyledButton
                key={`${oi}-${o.label}`}
                role={q.multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                disabled={dead}
                className="eva-question-option"
                data-selected={on ? 'true' : undefined}
                onClick={() => choose(page, o.label)}
              >
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  {oi < HOTKEYS && !dead ? (
                    <Kbd size="xs">{oi + 1}</Kbd>
                  ) : (
                    <Box w={20} style={{ flex: 'none' }} />
                  )}
                  <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm">{o.label}</Text>
                    {o.description ? (
                      <Text size="xs" c="dimmed">
                        {o.description}
                      </Text>
                    ) : null}
                  </Stack>
                  {on ? (
                    <IconCheck size={16} color="var(--mantine-primary-color-filled)" aria-hidden />
                  ) : null}
                </Group>
              </UnstyledButton>
            )
          })}
          {freeForm && !dead ? (
            <TextInput
              key={`typed-${q.id}`}
              aria-label="Your own answer"
              placeholder="Or type your own answer"
              value={text}
              onChange={(e) => type(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  advance()
                }
              }}
            />
          ) : null}
        </Stack>
        {showActions ? (
          <Group gap="xs" justify="flex-end">
            {qs.length > 1 ? (
              <Group gap={6} mr="auto" aria-hidden>
                {qs.map((x, i) => (
                  <Box
                    key={x.id}
                    h={6}
                    w={i === page ? 16 : 6}
                    bg={
                      i === page
                        ? 'var(--mantine-primary-color-filled)'
                        : answered(i)
                          ? 'var(--mantine-color-dimmed)'
                          : 'var(--mantine-color-default-border)'
                    }
                    style={{ borderRadius: 3 }}
                  />
                ))}
              </Group>
            ) : null}
            {page > 0 ? (
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                leftSection={<IconArrowLeft size={14} />}
                onClick={() => setPage(page - 1)}
              >
                Back
              </Button>
            ) : null}
            {last ? (
              <Button size="xs" disabled={!complete} onClick={() => submit(picks)}>
                Send answer
              </Button>
            ) : (
              <Button
                size="xs"
                disabled={!answered(page)}
                rightSection={<IconArrowRight size={14} />}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            )}
          </Group>
        ) : null}
        {dead ? (
          <Text size="xs" c="dimmed">
            This question can no longer be answered.
          </Text>
        ) : null}
      </Stack>
    </Paper>
  )
}
