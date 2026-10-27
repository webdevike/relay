import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { IconCheck, IconX } from '@tabler/icons-react'
import {
  isLegacyCost,
  type ArmCost,
  type ArmSummary,
  type CostTokens,
  type ExperimentCases,
  type LegacyArmCost,
  type SummaryRate,
} from '@evaos/contract'
import { invoke, on } from '../ipc'
import { openLink } from '../navigation/open-link'
import type { ExperimentArmView } from '../shell/layout-store'
import { ScrollArea } from '../ui/ScrollArea'
import { duration, pct, rateWithInterval, tokenCount, usd } from './experiment-format'

/** A measurement that does not apply: the harness's reason, or a plain fallback. */
function Missing({ reason }: { reason: string | undefined }) {
  return <span className="eva-bench-dim">{reason ?? 'Not reported'}</span>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="eva-bench-panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

/** Label-value rows separated by hairlines; values right-aligned. */
function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="eva-bench-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const rate = (r: SummaryRate): string => `${r.k}/${r.n} = ${pct(r.p)}`

const split = (t: CostTokens): string =>
  `${tokenCount(t.in)} in / ${tokenCount(t.out)} out / ${tokenCount(t.cached)} cached`

function LegacyCost({ cost }: { cost: LegacyArmCost }) {
  const fmt = (v: number) => (cost.unit === 'tokens' ? `${tokenCount(v)} tokens` : usd(v))
  return (
    <Facts
      rows={[
        ['Per test', fmt(cost.perTest)],
        ['Total', fmt(cost.total)],
      ]}
    />
  )
}

/** Tokens, list-price USD (published API prices) and billed USD, then the per-model split. */
function ArmCostDetail({ cost }: { cost: ArmCost }) {
  const rows: Array<[string, ReactNode]> = [['Tests costed', cost.tests]]
  if (cost.tokens) {
    rows.push(['Tokens per test (median)', split(cost.tokens.perTestMedian)])
    rows.push(['Tokens total', split(cost.tokens)])
  }
  if (cost.listUsd) {
    rows.push(['List $ per test (mean)', usd(cost.listUsd.perTest)])
    rows.push(['List $ per test (median)', usd(cost.listUsd.perTestMedian)])
    rows.push(['List $ total', usd(cost.listUsd.total)])
  } else {
    rows.push(['List $', <span key="list" className="eva-bench-dim">unpriced</span>])
    if (cost.unpriced) rows.push(['Unpriced tokens', split(cost.unpriced)])
  }
  if (cost.billedUsd) {
    rows.push(['Billed $ per test', usd(cost.billedUsd.perTest)])
    rows.push(['Billed $ total', `${usd(cost.billedUsd.total)} (${cost.billedUsd.tests} tests)`])
  }
  const priced = cost.byModel.filter((m) => m.price)
  const perM = (v: number | null) => (v === null ? '—' : `$${v}`)
  return (
    <>
      <Facts rows={rows} />
      {!cost.listUsd && cost.unpricedReason ? (
        <p className="eva-bench-faint" data-testid="cost-unpriced-reason">
          {cost.unpricedReason}
        </p>
      ) : null}
      {cost.byModel.length > 0 ? (
        <table className="eva-bench-mini" aria-label="Cost by model">
          <thead>
            <tr>
              <th>Model</th>
              <th>Calls</th>
              <th>In</th>
              <th>Out</th>
              <th>Cached</th>
              <th>List $</th>
            </tr>
          </thead>
          <tbody>
            {cost.byModel.map((m) => (
              <tr key={m.model ?? ''}>
                <td>{m.model ?? <span className="eva-bench-dim">(no model id)</span>}</td>
                <td>{m.calls}</td>
                <td>{tokenCount(m.tokensIn)}</td>
                <td>{tokenCount(m.tokensOut)}</td>
                <td>{tokenCount(m.tokensCached)}</td>
                <td>
                  {m.listUsd !== null ? (
                    usd(m.listUsd)
                  ) : (
                    <span className="eva-bench-dim" title={m.unpricedReason}>
                      unpriced
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {priced.map(({ model, price }) => {
        const p = price!
        let host = p.source
        try {
          host = new URL(p.source).host
        } catch {
          /* not a URL: show it as written */
        }
        return (
          <p key={model ?? ''} className="eva-bench-faint" data-testid="cost-price-source">
            {model ?? '(no model id)'}: {perM(p.input)} / {perM(p.output)} / {perM(p.cachedInput)}{' '}
            per Mtok —{' '}
            {/^https?:\/\//.test(p.source) ? (
              <a
                href={p.source}
                title={p.source}
                onClick={(e) => {
                  e.preventDefault()
                  openLink(p.source)
                }}
              >
                {host}
              </a>
            ) : (
              host
            )}{' '}
            (checked {p.checked})
          </p>
        )
      })}
    </>
  )
}

function Measurements({ arm }: { arm: ArmSummary }) {
  return (
    <>
      <Section title="Quality">
        {arm.quality && arm.quality.length > 0 ? (
          <table className="eva-bench-mini" aria-label="Quality per split">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Split</th>
                <th>k/n</th>
                <th>Rate (95% CI)</th>
              </tr>
            </thead>
            <tbody>
              {arm.quality.map((q) => (
                <tr key={`${q.metric}/${q.split}`}>
                  <td>{q.metric}</td>
                  <td>{q.split}</td>
                  <td>
                    {q.k}/{q.n}
                  </td>
                  <td>{rateWithInterval(q)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Missing reason={arm.qualityReason} />
        )}
        <Facts
          rows={[
            [
              'Dev to holdout gap',
              arm.gap ? (
                `${arm.gap.metric}: ${pct(arm.gap.dev)} dev, ${pct(arm.gap.holdout)} holdout (${arm.gap.diff >= 0 ? '+' : ''}${Math.round(arm.gap.diff * 100)} pts)`
              ) : (
                <Missing reason={arm.gapReason} />
              ),
            ],
          ]}
        />
      </Section>
      <Section title="Time per test">
        {arm.seconds ? (
          <Facts
            rows={[
              ['Median', duration(arm.seconds.median)],
              ['p90', duration(arm.seconds.p90)],
              ['Total', duration(arm.seconds.total)],
            ]}
          />
        ) : (
          <Missing reason={arm.secondsReason} />
        )}
      </Section>
      <Section title="Cost">
        {!arm.cost ? (
          <Missing reason={arm.costReason} />
        ) : isLegacyCost(arm.cost) ? (
          <LegacyCost cost={arm.cost} />
        ) : (
          <ArmCostDetail cost={arm.cost} />
        )}
      </Section>
      <Section title="Reliability">
        <Facts
          rows={[
            [
              'Repeat agreement',
              arm.repeatAgreement ? (
                rate(arm.repeatAgreement)
              ) : (
                <Missing reason={arm.repeatAgreementReason} />
              ),
            ],
            ['Failure rate', pct(arm.failures.rate)],
            ['Errors', arm.failures.errors],
            ['Timeouts', arm.failures.timeouts],
            ['Retries', arm.failures.retries],
            [
              'Judge audit agreement',
              arm.judgeAudit ? rate(arm.judgeAudit) : <Missing reason={arm.judgeAuditReason} />,
            ],
          ]}
        />
      </Section>
      <Section title="Calibration">
        {arm.calibration ? (
          <>
            <Facts rows={[['Expected calibration error', pct(arm.calibration.ece)]]} />
            <table className="eva-bench-mini" aria-label="Calibration bins">
              <thead>
                <tr>
                  <th>Confidence bin</th>
                  <th>n</th>
                  <th>Stated</th>
                  <th>Actual</th>
                </tr>
              </thead>
              <tbody>
                {arm.calibration.bins.map((b) => (
                  <tr key={`${b.lo}-${b.hi}`}>
                    <td>
                      {pct(b.lo)}-{pct(b.hi)}
                    </td>
                    <td>{b.n}</td>
                    <td>{pct(b.conf)}</td>
                    <td>{pct(b.acc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <Missing reason={arm.calibrationReason} />
        )}
      </Section>
      <Section title="Coverage">
        {arm.coverage ? (
          <>
            <Facts
              rows={[
                ['Run of planned', `${arm.coverage.run}/${arm.coverage.planned}`],
                ['Skipped', arm.coverage.skipped.length],
              ]}
            />
            {arm.coverage.skipped.length > 0 ? (
              <ul className="eva-bench-skipped">
                {arm.coverage.skipped.map((s, i) => (
                  <li key={i}>
                    <span className="eva-bench-mono">{s.case ?? 'holdout case'}</span>{' '}
                    <span className="eva-bench-dim">{s.reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <Missing reason={arm.coverageReason} />
        )}
      </Section>
    </>
  )
}

function Cases({ data }: { data: ExperimentCases | null }) {
  if (data === null) return <span className="eva-bench-dim">Loading cases</span>
  if (data.reason) return <span className="eva-bench-dim">{data.reason}</span>
  return (
    <>
      <span className="eva-bench-dim">
        {data.cases.length} runs from {data.file}
        {data.truncated ? ', first 5000 shown' : ''}
        {data.invalid ? `, ${data.invalid} unreadable lines skipped` : ''}
      </span>
      <table className="eva-bench-mini eva-bench-cases" aria-label="Cases">
        <thead>
          <tr>
            <th>Case</th>
            <th>Split</th>
            <th>Outcome</th>
            <th>s</th>
          </tr>
        </thead>
        <tbody>
          {data.cases.map((c, i) => (
            <tr key={i} data-failed={c.error ? 'true' : undefined}>
              <td className="eva-bench-mono">
                <span title={c.case}>
                  {c.case}
                  {c.repeat !== null && c.repeat > 1 ? (
                    <span className="eva-bench-dim"> #{c.repeat}</span>
                  ) : null}
                </span>
                {c.error ? <div className="eva-bench-error">{c.error}</div> : null}
              </td>
              <td>{c.split}</td>
              <td title={c.outcome ?? undefined}>
                {c.skipped ? (
                  <span className="eva-bench-dim">skipped: {c.skipped}</span>
                ) : c.passed !== null ? (
                  <span className="eva-bench-outcome" data-passed={c.passed}>
                    {c.passed ? <IconCheck size={12} /> : <IconX size={12} />}
                    {c.outcome}
                  </span>
                ) : (
                  (c.outcome ?? <span className="eva-bench-dim">none</span>)
                )}
              </td>
              <td>{c.seconds !== null ? c.seconds.toFixed(1) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Side panel body for one experiment arm: every measurement, then its case list. */
export function ExperimentArmPanel({ view }: { view: ExperimentArmView }) {
  const [arm, setArm] = useState<ArmSummary | null>(null)
  const [cases, setCases] = useState<ExperimentCases | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [detail, list] = await Promise.all([
      invoke('experiments.get', { id: view.experiment }),
      invoke('experiments.cases', { id: view.experiment, arm: view.arm }),
    ])
    if (!detail.ok) return setError(detail.error.message)
    const found = detail.value.armSummaries?.find((a) => a.id === view.arm) ?? null
    setArm(found)
    setError(found ? null : `This experiment's summary.json has no test ${view.arm}.`)
    setCases(
      list.ok
        ? list.value
        : { file: null, cases: [], invalid: 0, truncated: false, reason: list.error.message },
    )
  }, [view.experiment, view.arm])

  useEffect(() => {
    void load()
    return on('experiments.changed', ({ ids }) => {
      if (ids.includes(view.experiment)) void load()
    })
  }, [load, view.experiment])

  return (
    <ScrollArea className="eva-bench-panel" data-testid="experiment-arm-panel">
      <div className="eva-bench-panel-body">
        {error ? (
          <p className="eva-bench-warning" role="alert">
            {error}
          </p>
        ) : null}
        {arm ? (
          <>
            <span className="eva-bench-dim">
              {arm.role} · {arm.id} · {view.experiment}
            </span>
            <Measurements arm={arm} />
          </>
        ) : error ? null : (
          <span className="eva-bench-dim">Loading</span>
        )}
        <Section title="Cases">
          <Cases data={cases} />
        </Section>
      </div>
    </ScrollArea>
  )
}
