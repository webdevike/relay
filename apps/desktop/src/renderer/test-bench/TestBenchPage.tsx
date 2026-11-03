import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ActionIcon, Button, Progress, Tooltip } from '@mantine/core'
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconClock,
  IconFlask,
  IconHelpCircle,
  IconLoader2,
  IconRefresh,
  IconX,
  type Icon,
} from '@tabler/icons-react'
import type { Place } from '@evaos/shell-core'
import {
  isLegacyCost,
  type ArmSummary,
  type ExperimentDetail,
  type ExperimentRow,
  type ExperimentStatus,
} from '@evaos/contract'
import { invoke, on } from '../ipc'
import { Markdown } from '../chat/markdown/Markdown'
import { frontTabs } from '@evaos/shell-core'
import { openArmTab, useTiling } from '../tiling/tiling-store'
import { STATUS_LABEL, duration, pct, primaryRate, tokenCount, usd } from './experiment-format'
import { onExperimentRequest, takeExperimentRequest } from './bench-request'
import { ListEmpty, ListRow, ListView, rowTip, type ListColumn } from '../ui/list'
import './test-bench.css'

const STATUS_ICON: Record<ExperimentStatus, Icon> = {
  planned: IconClock,
  running: IconLoader2,
  pass: IconCheck,
  fail: IconX,
  inconclusive: IconHelpCircle,
}

export function StatusPill({
  status,
  progress,
}: {
  status: ExperimentStatus
  progress?: ExperimentRow['progress']
}) {
  const Glyph = STATUS_ICON[status]
  return (
    <span className="eva-bench-status" data-status={status} data-testid="experiment-status">
      <Glyph size={14} className={status === 'running' ? 'eva-bench-spin' : undefined} />
      {STATUS_LABEL[status]}
      {progress ? (
        <span className="eva-bench-progress-text">
          {progress.done}/{progress.planned ?? '?'}
        </span>
      ) : null}
    </span>
  )
}

function Headline({ row }: { row: ExperimentRow }) {
  const h = row.headline
  if (!h || (!h.control && !h.best))
    return <span className="eva-bench-dim">{row.hasSummary ? 'No quality yet' : 'No summary'}</span>
  return (
    <span className="eva-bench-headline" data-testid="experiment-headline">
      {h.control ? (
        <span>
          <span className="eva-bench-dim eva-bench-headline-label" title={h.control.label}>
            {h.control.label}
          </span>{' '}
          {pct(h.control.metric.p)}
        </span>
      ) : null}
      {h.control && h.best ? <span className="eva-bench-dim">vs</span> : null}
      {h.best ? (
        <span>
          <span className="eva-bench-dim eva-bench-headline-label" title={h.best.label}>
            {h.best.label}
          </span>{' '}
          <strong>{pct(h.best.metric.p)}</strong>
        </span>
      ) : null}
      <span className="eva-bench-faint">{(h.best ?? h.control)!.metric.metric}</span>
    </span>
  )
}

/** `$1.24 list · 3.4M tok`, with billed $ when nothing is priced and an unpriced-arms hint. */
function RowCost({ cost }: { cost: ExperimentRow['cost'] }) {
  const parts = [
    cost?.listUsd != null ? `${usd(cost.listUsd)} list` : null,
    cost?.billedUsd != null && cost.listUsd == null ? `${usd(cost.billedUsd)} billed` : null,
    cost?.tokens != null ? `${tokenCount(cost.tokens)} tok` : null,
  ].filter(Boolean)
  if (!cost || parts.length === 0) return <span className="eva-bench-dim">No cost</span>
  return (
    <span className="eva-bench-run-cost" data-testid="experiment-cost">
      <span>{parts.join(' · ')}</span>
      {cost.unpricedArms > 0 ? (
        <span className="eva-bench-faint">
          {cost.unpricedArms} {cost.unpricedArms === 1 ? 'arm' : 'arms'} unpriced
        </span>
      ) : null}
    </span>
  )
}

function TokensCell({ cost }: { cost: ArmSummary['cost'] }) {
  if (cost && isLegacyCost(cost))
    return cost.unit === 'tokens' ? (
      <>{tokenCount(cost.perTest)}</>
    ) : (
      <span className="eva-bench-dim">n/a</span>
    )
  const m = cost?.tokens?.perTestMedian
  if (!m) return <span className="eva-bench-dim">n/a</span>
  return (
    <span title={`Median per test: in ${m.in} · out ${m.out} · cached ${m.cached}`}>
      {tokenCount(m.total)}
    </span>
  )
}

function ListUsdCell({ cost }: { cost: ArmSummary['cost'] }) {
  if (!cost) return <span className="eva-bench-dim">n/a</span>
  if (isLegacyCost(cost))
    return cost.unit === 'usd' ? (
      <span className="eva-bench-dim">{usd(cost.perTest)} billed</span>
    ) : (
      <span className="eva-bench-dim" title="Logged before list prices">
        unpriced
      </span>
    )
  if (cost.listUsd) return <>{usd(cost.listUsd.perTest)}</>
  return (
    <span className="eva-bench-dim" title={cost.unpricedReason}>
      unpriced
    </span>
  )
}

/** Primary rate per list dollar per test; null when either side is missing. */
function qualityPerDollar(arm: ArmSummary, primary: string): number | null {
  const rate = primaryRate(arm, primary)
  const cost = arm.cost && !isLegacyCost(arm.cost) ? arm.cost.listUsd : null
  return rate && cost && cost.perTest > 0 ? rate.p / cost.perTest : null
}

/** Activates on click, Enter or Space, like the Jobs rows. */
function rowProps(onOpen: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        onOpen()
      }
    },
  } as const
}

const RUN_COLUMNS: ListColumn[] = [
  { id: 'run', label: 'Run', width: 'minmax(120px, 1fr)' },
  { id: 'quality', label: 'Quality', width: 'minmax(0, auto)', align: 'end' },
  { id: 'cost', label: 'Cost', width: 'minmax(96px, auto)', align: 'end' },
  { id: 'status', label: 'Status', width: '140px', align: 'end' },
]

function RunsList({
  rows,
  error,
  onOpen,
}: {
  rows: ExperimentRow[] | null
  error: string | null
  onOpen: (id: string) => void
}) {
  return (
    <ListView<ExperimentRow>
      data-testid="experiments-list"
      columns={RUN_COLUMNS}
      groups={[{ id: 'runs', items: rows ?? [] }]}
      loading={rows === null ? { label: 'Loading experiments' } : false}
      error={
        rows === null && error ? (
          <ListEmpty role="alert" icon={<IconAlertTriangle size={24} stroke={1.5} />}>
            Could not read work/experiments ({error}).
          </ListEmpty>
        ) : undefined
      }
      empty={
        <ListEmpty
          data-testid="experiments-empty"
          icon={<IconFlask size={24} stroke={1.5} />}
          title="No experiments yet"
        >
          Experiments started with bun .omp/tools/exp.ts init show up here as they run.
        </ListEmpty>
      }
      rowKey={(row) => row.id}
      renderRow={(row) => (
        <ListRow
          key={row.id}
          data-testid={`experiment-row-${row.id}`}
          title={row.title}
          tooltip={rowTip(
            row.title,
            [
              row.date,
              row.round !== null ? `round ${row.round}` : null,
              row.arms !== null ? `${row.arms} ${row.arms === 1 ? 'test' : 'tests'}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
          )}
          onActivate={() => onOpen(row.id)}
          cells={[
            <Headline key="h" row={row} />,
            <RowCost key="c" cost={row.cost} />,
            <span key="s" className="eva-bench-run-status">
              <StatusPill status={row.status} progress={row.progress} />
              {row.progress?.planned ? (
                <Progress
                  size="xs"
                  w={96}
                  value={(100 * row.progress.done) / row.progress.planned}
                  aria-label="Cases done"
                />
              ) : null}
            </span>,
          ]}
        />
      )}
    />
  )
}

function ArmsTable({ detail }: { detail: ExperimentDetail }) {
  const arms = detail.armSummaries ?? []
  const selected = useTiling((s) => {
    const tab = frontTabs(s.tiling).find(
      (t) => t.kind === 'experiment-arm' && t.experiment === detail.id,
    )
    return tab?.kind === 'experiment-arm' ? tab.arm : null
  })
  const open = (arm: ArmSummary) =>
    openArmTab({ experiment: detail.id, arm: arm.id, label: arm.label })
  return (
    <div
      className="eva-bench-table"
      role="table"
      aria-label="Tests"
      data-testid="arms-table"
      data-quality-per-dollar={detail.primary !== null ? 'true' : undefined}
    >
      <div className="eva-bench-arm eva-bench-thead" role="row">
        <span role="columnheader">Test</span>
        <span role="columnheader" className="eva-bench-cap">
          {detail.primary ?? 'Quality'}
        </span>
        <span role="columnheader">s/test</span>
        <span role="columnheader">Tokens/test</span>
        <span role="columnheader" title="List-price USD per test (mean), at published API prices">
          List $/test
        </span>
        {detail.primary !== null ? (
          <span role="columnheader" title="Primary rate per list dollar per test">
            Quality/$
          </span>
        ) : null}
        <span role="columnheader">Failures</span>
        <span role="columnheader">Coverage</span>
      </div>
      {arms.map((arm) => {
        const rate = primaryRate(arm, detail.primary)
        const perDollar = detail.primary !== null ? qualityPerDollar(arm, detail.primary) : null
        return (
          <div
            key={arm.id}
            className="eva-bench-arm"
            data-selected={selected === arm.id ? 'true' : undefined}
            data-testid={`arm-row-${arm.id}`}
            {...rowProps(() => open(arm))}
            role="row"
          >
            <span className="eva-bench-arm-name" role="cell">
              <span className="eva-bench-arm-title">{arm.label}</span>
              <span className="eva-bench-dim">
                {arm.role}
                {arm.id !== arm.role && arm.id !== arm.label ? ` · ${arm.id}` : ''}
              </span>
            </span>
            <span role="cell">
              {rate ? (
                <Tooltip label={`${rate.k}/${rate.n} on ${rate.split}`} openDelay={300}>
                  <span>
                    {pct(rate.p)}{' '}
                    <span className="eva-bench-dim">
                      ({Math.round(rate.lo * 100)}-{Math.round(rate.hi * 100)})
                    </span>
                  </span>
                </Tooltip>
              ) : (
                <span className="eva-bench-dim">n/a</span>
              )}
            </span>
            <span role="cell">
              {arm.seconds ? (
                duration(arm.seconds.median)
              ) : (
                <span className="eva-bench-dim">n/a</span>
              )}
            </span>
            <span role="cell">
              <TokensCell cost={arm.cost} />
            </span>
            <span role="cell">
              <ListUsdCell cost={arm.cost} />
            </span>
            {detail.primary !== null ? (
              <span role="cell">
                {perDollar !== null ? (
                  perDollar.toFixed(perDollar < 10 ? 2 : perDollar < 100 ? 1 : 0)
                ) : (
                  <span className="eva-bench-dim">n/a</span>
                )}
              </span>
            ) : null}
            <span role="cell">{pct(arm.failures.rate)}</span>
            <span role="cell">
              {arm.coverage ? (
                `${arm.coverage.run}/${arm.coverage.planned}`
              ) : (
                <span className="eva-bench-dim">n/a</span>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function RunDetail({ detail, onBack }: { detail: ExperimentDetail; onBack: () => void }) {
  const meta = [
    detail.date,
    detail.round !== null ? `round ${detail.round}` : null,
    detail.arms !== null ? `${detail.arms} ${detail.arms === 1 ? 'test' : 'tests'}` : null,
    detail.id,
  ].filter(Boolean)
  return (
    <div className="eva-bench-detail" data-testid="experiment-detail">
      <div>
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<IconArrowLeft size={14} />}
          onClick={onBack}
          data-testid="experiment-back"
        >
          Experiments
        </Button>
      </div>
      <header className="eva-bench-detail-head">
        <div className="eva-bench-title-line">
          <h1 className="eva-bench-title">{detail.title}</h1>
          <StatusPill status={detail.status} progress={detail.progress} />
        </div>
        <span className="eva-bench-dim">{meta.join(' · ')}</span>
      </header>
      {detail.question ? <p className="eva-bench-question">{detail.question}</p> : null}
      {detail.verdict ? (
        <div className="eva-bench-verdict" data-testid="experiment-verdict">
          <span className="eva-bench-label">Verdict</span>
          <p>{detail.verdict}</p>
        </div>
      ) : null}
      {detail.summaryError ? (
        <p className="eva-bench-warning" role="alert">
          summary.json could not be read ({detail.summaryError}). Showing results.md instead.
        </p>
      ) : null}
      {detail.armSummaries ? (
        <ArmsTable detail={detail} />
      ) : detail.resultsMarkdown ? (
        <div className="eva-bench-results" data-testid="experiment-results-md">
          <Markdown text={detail.resultsMarkdown} />
        </div>
      ) : (
        <p className="eva-bench-dim">No summary.json or results.md yet.</p>
      )}
    </div>
  )
}

/**
 * Test Bench: every experiment Eva runs through `.omp/tools/exp.ts`, read from
 * `work/experiments`. Runs list, then one run's tests; a test's details open in a tool tab.
 */
export function TestBenchPage(_props: { place: Place }) {
  const [rows, setRows] = useState<ExperimentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ExperimentDetail | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const loadList = useCallback(async () => {
    const r = await invoke('experiments.list', {})
    if (r.ok) {
      setRows(r.value)
      setError(null)
    } else setError(r.error.message)
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    const r = await invoke('experiments.get', { id })
    if (selectedRef.current !== id) return
    if (r.ok) setDetail(r.value)
    else setError(r.error.message)
  }, [])

  useEffect(() => {
    void loadList()
    return on('experiments.changed', ({ ids }) => {
      void loadList()
      const current = selectedRef.current
      if (current && ids.includes(current)) void loadDetail(current)
    })
  }, [loadList, loadDetail])

  useEffect(() => {
    setDetail(null)
    if (selected) void loadDetail(selected)
  }, [selected, loadDetail])

  useEffect(() => {
    const asked = takeExperimentRequest()
    if (asked) setSelected(asked)
    return onExperimentRequest(setSelected)
  }, [])

  let body
  if (selected) {
    body = detail ? (
      <RunDetail detail={detail} onBack={() => setSelected(null)} />
    ) : (
      <p className="eva-bench-dim">Loading experiment</p>
    )
  } else {
    body = <RunsList rows={rows} error={error} onOpen={setSelected} />
  }

  return (
    <div className="eva-bench-col" data-testid="page-test-bench">
      {selected ? null : (
        <div className="eva-bench-head">
          <h1 className="eva-bench-title">Test Bench</h1>
          <span className="eva-bench-dim">Eva's experiments, newest first</span>
          <span className="eva-bench-spacer" />
          <Tooltip label="Refresh" openDelay={300}>
            <ActionIcon
              variant="default"
              aria-label="Refresh experiments"
              onClick={() => void loadList()}
            >
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
        </div>
      )}
      {body}
    </div>
  )
}
