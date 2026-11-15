import { useEffect, useId, useRef } from 'react'
import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { WIDGET_LABEL_TEXT, type WidgetLabel } from '@evaos/chat-core/reactions'
import { invoke } from '../../ipc'

const SHOULD_HAVE_BEEN: readonly WidgetLabel[] = ['plain', 'chart', 'table', 'card', 'other']

export const TRAIN_FAILED = "Couldn't save that for training."

/**
 * Sends Isaac's 🎯 answer for assistant reply `message` of `thread` to the host (`widget.label`,
 * read on the desktop); a refusal or no connection shows a toast.
 */
export async function sendWidgetLabel(
  thread: string,
  message: string,
  label: WidgetLabel,
  excerpt: string,
): Promise<void> {
  const r = await invoke('reactions.widgetLabel', { thread, message, label, excerpt })
  if (r.ok && r.value.ok) return
  const why = r.ok ? r.value.error : r.error.message
  notifications.show({
    color: 'red',
    message: why ? `${TRAIN_FAILED} ${why}` : TRAIN_FAILED,
    autoClose: 6000,
  })
}

/**
 * The one question 🎯 asks on an assistant's reply: keep what was shown, or what it should have
 * been. One tap answers and closes; closing it otherwise answers nothing.
 */
export function TrainSheet({ onPick }: { onPick(label: WidgetLabel): void }) {
  const should = useId()
  const keep = useRef<HTMLButtonElement>(null)
  // It takes the bar's place inside the same trap, so focus moves to the first answer.
  useEffect(() => keep.current?.focus(), [])
  return (
    <div className="eva-train-sheet" data-testid="train-sheet">
      <div className="eva-train-title">Train on this</div>
      <Button size="xs" ref={keep} data-testid="train-keep" onClick={() => onPick('keep')}>
        {WIDGET_LABEL_TEXT.keep}
      </Button>
      <div className="eva-train-label" id={should}>
        Should&apos;ve been:
      </div>
      <div className="eva-train-options" role="group" aria-labelledby={should}>
        {SHOULD_HAVE_BEEN.map((label) => (
          <Button
            key={label}
            size="xs"
            variant="default"
            data-testid={`train-${label}`}
            onClick={() => onPick(label)}
          >
            {WIDGET_LABEL_TEXT[label]}
          </Button>
        ))}
      </div>
    </div>
  )
}
