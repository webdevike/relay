import './trials.css'
import { memo, useState } from 'react'
import { Button } from '@mantine/core'
import type { TrialSwitchView } from '@evaos/contract'
import { undoSwitch, useTrials } from './trials-store'

/**
 * The specialist's own message after it switched its model on Isaac's picks (or kept it), as a
 * reply in the chat, with an Undo that brings the old model and the trial back. Once undone it
 * says so instead of the button.
 */
function TrialSwitchRowImpl({ change }: { change: TrialSwitchView }) {
  const up = useTrials((s) => s.up)
  const [sending, setSending] = useState(false)
  return (
    <div className="eva-row" data-role="assistant" data-testid={`trial-switch-${change.id}`}>
      <div className="eva-row-inner">
        <div className="eva-trial-switch">
          <p className="eva-trial-switch-text">{change.text}</p>
          {change.undone ? (
            <p className="eva-trial-switch-undone" data-testid="trial-undone">
              Undone: back on {change.fromLabel}, trial on again
            </p>
          ) : (
            <Button
              size="xs"
              variant="default"
              data-testid="trial-undo"
              loading={sending}
              disabled={!up}
              onClick={() => {
                setSending(true)
                // Taken: the host's next message says it is undone and the button goes.
                void undoSwitch(change.id).then((ok) => {
                  if (!ok) setSending(false)
                })
              }}
            >
              Undo
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export const TrialSwitchRow = memo(TrialSwitchRowImpl)
