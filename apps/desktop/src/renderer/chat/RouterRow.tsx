import './run-details.css'
import './router-row.css'
import { useState } from 'react'
import { IconRoute } from '@tabler/icons-react'
import {
  routerDetail,
  routerLine,
  routerParts,
  routerPicked,
  type RouterTurn,
} from '@relay/protocol'
import { EvaPopover } from '../overlay'

/**
 * Eva's specialist router under Isaac's bubble in an assistant thread (protocol `specialist-router`): one quiet
 * line (`Router: web-researcher · 0.86 · <why> · used`), the why truncating on one line while the mark stays.
 * A click opens the whole decision and its outcome. Only a picked specialist shows: none and skipped (timeout,
 * error) render nothing and stay in the shadow log.
 */
export function RouterRow({ turn }: { turn: RouterTurn }) {
  return routerPicked(turn.decision) ? <PickedRouterRow turn={turn} /> : null
}

function PickedRouterRow({ turn }: { turn: RouterTurn }) {
  const [opened, setOpened] = useState(false)
  const { head, why, mark } = routerParts(turn.decision, turn.outcome)
  const line = routerLine(turn.decision, turn.outcome)
  return (
    <EvaPopover opened={opened} onChange={setOpened} position="bottom-end" width={420} shadow="md">
      <EvaPopover.Target>
        <button
          type="button"
          className="eva-router-row eva-label"
          data-testid="router-row"
          data-agent={turn.decision.agent}
          aria-label={line}
          aria-expanded={opened}
          title={line}
          onClick={() => setOpened((o) => !o)}
        >
          <IconRoute size={12} stroke={1.5} aria-hidden="true" />
          <span className="eva-router-head">{head}</span>
          {why === undefined ? null : <span className="eva-router-why"> · {why}</span>}
          {mark === undefined ? null : (
            <span className="eva-router-mark" data-testid="router-mark">
              {' '}
              · {mark}
            </span>
          )}
        </button>
      </EvaPopover.Target>
      <EvaPopover.Dropdown>
        <div className="eva-agents-details eva-router-details" data-testid="router-details">
          <section className="eva-agents-run">
            <div className="eva-agents-run-head">
              <span className="eva-agents-run-name">Specialist router</span>
            </div>
            <dl className="eva-agents-fields">
              {routerDetail(turn).map(([label, value]) => (
                <div key={label} className="eva-agents-field">
                  <dt>{label}</dt>
                  <dd>
                    {label === 'Suggested request' ? (
                      <pre className="eva-tool-code">{value}</pre>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </EvaPopover.Dropdown>
    </EvaPopover>
  )
}
