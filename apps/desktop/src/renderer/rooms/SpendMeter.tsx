import { Tooltip } from '@mantine/core'
import { councilApprox, councilMoney } from '@relay/protocol'
import type { RoomCouncil } from '@evaos/contract'
import { spendMeter } from './council-view'

/** Spent so far against the estimate and the hard cap; amber from 80 % of the cap. */
export function SpendMeter({ council }: { council: RoomCouncil }) {
  const { spend } = council
  const m = spendMeter(spend, council.paused === true)
  return (
    <Tooltip
      label="List price spent so far, the estimate, and the hard cap. The room pauses at 80% of the cap."
      openDelay={300}
      multiline
      maw={260}
    >
      <div className="eva-meter" data-warn={m.warn || undefined} data-testid="room-spend">
        <span className="eva-meter-text">
          <b>{councilMoney(spend.usd)}</b> of {councilApprox(spend.estimate)} · cap{' '}
          {councilMoney(spend.cap)}
        </span>
        <span
          className="eva-meter-bar"
          role="meter"
          aria-label="Spend against the cap"
          aria-valuemin={0}
          aria-valuemax={spend.cap}
          aria-valuenow={spend.usd}
        >
          <b style={{ width: `${m.ratio * 100}%` }} />
          <i style={{ left: `${m.estimateAt * 100}%` }} />
        </span>
      </div>
    </Tooltip>
  )
}
