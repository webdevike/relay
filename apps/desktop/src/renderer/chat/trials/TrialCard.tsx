import './trials.css'
import { memo, useState, type CSSProperties } from 'react'
import { Button } from '@mantine/core'
import { AGENT_BADGE_STALE_MS, agentClock, canPickTrial } from '@relay/protocol'
import type { TrialCardView, TrialPickValue } from '@evaos/contract'
import { Markdown } from '../markdown/Markdown'
import { useSecond } from '../WorkCard'
import { pickTrial, useTrials } from './trials-store'

/** The card's question, then what Isaac answered. */
function heading(trial: TrialCardView): string {
  if (trial.pick === undefined) return `${trial.label} · which is better?`
  if (trial.pick === 'unsure') return `${trial.label} · you couldn't tell`
  return `${trial.label} · you picked ${trial.pick}`
}

/**
 * One request on three models, side by side as A / B / C with no model names: each pane runs
 * until its result arrives, then shows it (Markdown, so an image draws; a click opens it full
 * size). Isaac taps the better one or Can't tell; the host reveals the models after the pick, and
 * the picked pane stays marked. Panes keep one height while results stream in, so the log around
 * the card never moves.
 */
function TrialCardImpl({ trial }: { trial: TrialCardView }) {
  const up = useTrials((s) => s.up)
  const [sending, setSending] = useState<TrialPickValue | null>(null)
  const picked = trial.pick !== undefined
  const now = useSecond(trial.arms.some((a) => a.status === 'running'))
  const choose = (pick: TrialPickValue): void => {
    setSending(pick)
    // A recorded pick keeps the buttons off until the host's revealed card replaces them.
    void pickTrial(trial.id, pick).then((ok) => {
      if (!ok) setSending(null)
    })
  }
  const button = (pick: TrialPickValue, label: string) => (
    <Button
      key={pick}
      size="xs"
      variant="default"
      data-testid={`trial-pick-${pick}`}
      loading={sending === pick}
      disabled={!up || sending !== null || !canPickTrial(trial, pick)}
      onClick={() => choose(pick)}
    >
      {label}
    </Button>
  )
  return (
    <div className="eva-row" data-role="trial" data-testid={`trial-${trial.id}`}>
      <div className="eva-row-inner">
        <section className="eva-trial" aria-label={heading(trial)}>
          <div className="eva-trial-head">
            <span className="eva-trial-title">{heading(trial)}</span>
            {trial.request ? (
              <span className="eva-trial-request" title={trial.request}>
                {trial.request}
              </span>
            ) : null}
          </div>
          <div
            className="eva-trial-panes"
            style={{ '--eva-trial-arms': trial.arms.length } as CSSProperties}
          >
            {trial.arms.map((arm) => (
              <div
                key={arm.letter}
                className="eva-trial-pane"
                data-testid={`trial-pane-${arm.letter}`}
                data-status={arm.status}
                data-picked={trial.pick === arm.letter || undefined}
              >
                <div className="eva-trial-pane-head">
                  <span className="eva-trial-letter">{arm.letter}</span>
                  <span className="eva-trial-model" data-testid={`trial-model-${arm.letter}`}>
                    {picked ? (arm.modelLabel ?? arm.model ?? '') : ''}
                  </span>
                </div>
                <div className="eva-trial-body">
                  {arm.status === 'running' ? (
                    <span className="eva-trial-note" aria-label="Still running">
                      <span className="eva-spinner" aria-hidden="true" />
                      {/* A clock as the badges keep one; an arm out this long has no clock worth reading. */}
                      {now - trial.at < AGENT_BADGE_STALE_MS
                        ? agentClock(now - trial.at, true)
                        : null}
                    </span>
                  ) : arm.status === 'failed' ? (
                    <span className="eva-trial-note" title={arm.error}>
                      Didn&apos;t finish
                    </span>
                  ) : (
                    <div className="eva-trial-preview">
                      <Markdown text={arm.preview ?? ''} />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {picked ? null : (
            <div className="eva-trial-picks" role="group" aria-label="Pick the better one">
              {trial.arms.map((arm) => button(arm.letter, arm.letter))}
              {button('unsure', "Can't tell")}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export const TrialCard = memo(TrialCardImpl)
