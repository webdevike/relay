import { IconChevronRight } from '@tabler/icons-react'
import type { RoomCouncil } from '@evaos/contract'
import { phaseSteps, roundHint } from './council-view'

/** Brief, Contract or Plan, Round 1..N, Converge, Deliver; during a round, its five moves. */
export function PhaseStrip({ council, resolved }: { council: RoomCouncil; resolved: boolean }) {
  const steps = phaseSteps(council, resolved)
  const hint = resolved ? null : roundHint(council.stage, council.parts.length > 1)
  return (
    <div className="eva-phases" data-testid="room-phases">
      <ol className="eva-phases-row" aria-label="Where the room is">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className="eva-phase"
            data-state={s.state}
            aria-current={s.state === 'now' ? 'step' : undefined}
          >
            {i > 0 ? (
              <IconChevronRight size={12} stroke={1.5} className="eva-phase-sep" aria-hidden />
            ) : null}
            <span className="eva-phase-name">{s.label}</span>
          </li>
        ))}
      </ol>
      {hint ? (
        <ol
          className="eva-phases-row eva-phases-hint"
          aria-label="This round"
          data-testid="round-hint"
        >
          {hint.map((s, i) => (
            <li key={s.key} className="eva-phase" data-state={s.state}>
              {i > 0 ? (
                <IconChevronRight size={12} stroke={1.5} className="eva-phase-sep" aria-hidden />
              ) : null}
              <span className="eva-phase-name">{s.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
