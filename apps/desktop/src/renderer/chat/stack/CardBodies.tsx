import { useEffect, useState } from 'react'
import { ActionIcon, Button, Textarea, TextInput } from '@mantine/core'
import { IconArrowRight, IconArrowUp } from '@tabler/icons-react'
import type { DialogResponse } from '@evaos/contract'
import { runClock } from '@evaos/chat-core/card-stack'
import anthropicLogo from '../../assets/vendors/anthropic.png'
import openaiLogo from '../../assets/vendors/openai.png'
import { invoke } from '../../ipc'
import { ExtensionUiCard } from '../cards/ExtensionUiCard'
import { QuestionCard } from '../cards/QuestionCard'
import type { AskCard, DialogCard, RunCard } from './stack-cards'

const LOGO = { anthropic: anthropicLogo, openai: openaiLogo } as const

/**
 * An open ask: what it asks, then its answers (two side by side, more as a list, or a typed answer
 * when it offers none), and a typed answer under the options.
 */
export function AskBody({ card, onAnswer }: { card: AskCard; onAnswer: (reply: string) => void }) {
  const [text, setText] = useState('')
  const replies = card.ask.replies
  const submit = (): void => {
    if (text.trim() !== '') onAnswer(text.trim())
  }
  return (
    <div className="eva-stack-ask" data-kind="ask">
      {card.detail === null ? null : <div className="eva-stack-detail">{card.detail}</div>}
      {replies.length === 2 ? (
        <div className="eva-stack-yn">
          <Button fullWidth onClick={() => onAnswer(replies[0]!)}>
            {replies[0]}
          </Button>
          <Button fullWidth variant="default" onClick={() => onAnswer(replies[1]!)}>
            {replies[1]}
          </Button>
        </div>
      ) : replies.length > 0 ? (
        <div className="eva-stack-opts">
          {replies.map((r) => (
            <button key={r} type="button" className="eva-stack-opt" onClick={() => onAnswer(r)}>
              <span className="eva-stack-opt-label">{r}</span>
            </button>
          ))}
        </div>
      ) : null}
      {replies.length === 0 ? (
        <div>
          <Textarea
            autosize
            minRows={2}
            maxRows={4}
            aria-label="Your answer"
            placeholder="Type your answer"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          <Button
            mt={8}
            fullWidth
            disabled={text.trim() === ''}
            onClick={submit}
            rightSection={<IconArrowRight size={16} />}
          >
            Send answer
          </Button>
        </div>
      ) : (
        <TextInput
          mt={10}
          size="sm"
          aria-label="Or type an answer"
          placeholder="Or type an answer"
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
          rightSection={
            <ActionIcon
              size="sm"
              radius="xl"
              disabled={text.trim() === ''}
              onClick={submit}
              aria-label="Send answer"
            >
              <IconArrowUp size={14} />
            </ActionIcon>
          }
        />
      )}
    </div>
  )
}

/** The time, every second while `on`. */
function useSecond(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

/** Work in progress: how long it has run and on what model, its recent work, and the way to it. */
export function RunningBody({
  card,
  onOpen,
}: {
  card: RunCard
  /** `split`: Cmd (or Ctrl) was held, so open it beside the pane instead of in place. */
  onOpen: (split: boolean) => void
}) {
  const now = useSecond(card.startedAt !== null)
  const named = card.model !== null || card.vendor !== null
  return (
    <div className="eva-stack-ask" data-kind="run">
      {card.startedAt !== null || named ? (
        <div className="eva-stack-run-head">
          {card.startedAt === null ? null : (
            <span className="eva-stack-run-timer" data-testid="card-stack-timer">
              {runClock(now - card.startedAt)}
            </span>
          )}
          {named ? (
            <span className="eva-stack-run-model" data-testid="card-stack-model">
              {card.vendor === null ? null : (
                <img
                  className="eva-stack-run-logo"
                  data-mono={card.vendor === 'openai' ? 'true' : undefined}
                  data-vendor={card.vendor}
                  src={LOGO[card.vendor]}
                  alt=""
                />
              )}
              {card.model}
            </span>
          ) : null}
        </div>
      ) : null}
      {card.log.length === 0 ? null : (
        <div className="eva-stack-run-log" data-testid="card-stack-log">
          {card.log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      <Button
        mt={12}
        fullWidth
        variant="default"
        data-testid="card-stack-open-session"
        onClick={(e) => onOpen(e.metaKey || e.ctrlKey)}
      >
        Open session
      </Button>
    </div>
  )
}

/** The session's question or approval, answered through omp; a refused answer says why under it. */
export function DialogBody({
  paneId,
  card,
  onAnswering,
}: {
  paneId: string
  card: DialogCard
  /** Right before the answer goes out. */
  onAnswering: () => void
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const dialog = card.dialog
  const answer = async (response: DialogResponse): Promise<boolean> => {
    setFailed(null)
    onAnswering()
    const r = await invoke('chat.answerUi', { paneId, id: dialog.id, response })
    if (!r.ok) {
      setFailed(r.error.message)
      return false
    }
    if (!r.value.sent) {
      setFailed('This question is no longer waiting for an answer.')
      return false
    }
    return true
  }
  return (
    <div className="eva-stack-dialog">
      {dialog.kind === 'select' || dialog.kind === 'ask' ? (
        <QuestionCard key={dialog.id} dialog={dialog} titled onAnswer={answer} />
      ) : (
        <ExtensionUiCard key={dialog.id} dialog={dialog} titled onAnswer={answer} />
      )}
      {failed ? (
        <div className="eva-error-banner" role="alert">
          {failed}
        </div>
      ) : null}
    </div>
  )
}
