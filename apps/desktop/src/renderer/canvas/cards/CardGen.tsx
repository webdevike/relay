/**
 * What a component card or frame shows while an agent makes it (agent/card-gen.machine.ts), after
 * pen.dev: while content streams in, a label over the frame ("Generating: <board> • <title>" in
 * the accent) and in the frame a soft accent light drifting slowly (one composited layer moved by
 * transform; under reduced motion only the label shows); while it is being created and nothing
 * drew yet, a spinner. Between edits (settled) the card looks as always and the light fades out.
 */
import { Loader } from '@mantine/core'
import { IconAlertTriangle, IconSparkles } from '@tabler/icons-react'
import type { CardGenState } from '../agent/card-gen.machine'
import { useCanvasRuns } from '../agent/runs-store'

const VERB: Partial<Record<CardGenState, string>> = {
  creating: 'Creating',
  streaming: 'Generating',
  error: 'Did not draw',
}

/** The card shows its own title: nobody makes it, or the agent is between edits. */
export const quietGen = (state: CardGenState): boolean => state === 'idle' || state === 'settled'

/** The label in place of a card's title while it has a generation state to show; else null. */
export function GenLabel({
  id,
  slug,
  state,
  title,
}: {
  id: string
  slug: string
  state: CardGenState
  title: string
}) {
  const board = useCanvasRuns((s) => s.runs.find((r) => r.slug === slug)?.board)
  const verb = VERB[state]
  if (verb === undefined) return null
  const where = board && board !== title ? `${board} • ${title}` : title
  return (
    <span className="eva-cv-gen-label" data-gen={state} data-testid={`canvas-gen-label-${id}`}>
      {state === 'error' ? (
        <IconAlertTriangle size={12} stroke={1.75} aria-hidden />
      ) : (
        <IconSparkles size={12} stroke={1.75} aria-hidden />
      )}
      <span className="eva-cv-gen-text">{`${verb}: ${where}`}</span>
    </span>
  )
}

/**
 * The frame's light (creating, streaming; fading out once settled) and, while it is being created
 * with nothing drawn yet, a centered spinner. Rendered inside the frame, over its content.
 */
export function GenGlow({ state, empty }: { state: CardGenState; empty: boolean }) {
  if (state === 'idle' || state === 'error') return null
  return (
    <div className="eva-cv-gen-glow" data-gen={state} aria-hidden>
      {state === 'creating' && empty ? (
        <Loader className="eva-cv-gen-spinner" size={28} color="var(--eva-c-muted-foreground)" />
      ) : null}
    </div>
  )
}
