import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ActionIcon, Button, Progress, Tooltip } from '@mantine/core'
import {
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
import type { ArmSummary, ExperimentDetail, ExperimentRow, ExperimentStatus } from '@evaos/contract'
import { invoke, on } from '../ipc'
import { Markdown } from '../chat/markdown/Markdown'
import { openExperimentArmPanel, useLayout } from '../shell/layout-store'
import { STATUS_LABEL, duration, money, pct, primaryRate } from './experiment-format'
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
          <span className="eva-bench-dim">{h.control.label} </span>
          {pct(h.control.metric.p)}
        </span>
      ) : null}
      {h.control && h.best ? <span className="eva-bench-dim">vs</span> : null}
      {h.best ? (
        <span>
          <span className="eva-bench-dim">{h.best.label} </span>
          <strong>{pct(h.best.metric.p)}</strong>
        </span>
      ) : null}
      <span className="eva-bench-faint">{(h.best ?? h.control)!.metric.metric}</span>
    </span>
  )
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

function RunsList({ rows, onOpen }: { rows: ExperimentRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="eva-bench-list" data-testid="experiments-list">
      {rows.map((row) => {
        const meta = [
          row.date,
          row.round !== null ? `round ${row.round}` : null,
          row.arms !== null ? `${row.arms} ${row.arms === 1 ? 'test' : 'tests'}` : null,
        ].filter(Boolean)
        return (
          <div
            key={row.id}
            className="eva-bench-run"
            data-testid={`experiment-row-${row.id}`}
            {...rowProps(() => onOpen(row.id))}
          >
            <span className="eva-bench-run-main">
              <span className="eva-bench-run-title">{row.title}</span>
              <span className="eva-bench-dim">{meta.join(' · ')}</span>
            </span>
            <Headline row={row} />
            <span className="eva-bench-run-status">
              <StatusPill status={row.status} progress={row.progress} />
              {row.progress?.planned ? (
                <Progress
                  size="xs"
                  w={96}
                  value={(100 * row.progress.done) / row.progress.planned}
                  aria-label="Cases done"
                />
              ) : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ArmsTable({ detail }: { detail: ExperimentDetail }) {
  const arms = detail.armSummaries ?? []
  const selected = useLayout((s) =>
    s.panelOpen && s.panelView.kind === 'experiment-arm' && s.panelView.experiment === detail.id
      ? s.panelView.arm
      : null,
  )
  const open = (arm: ArmSummary) =>
    openExperimentArmPanel({ experiment: detail.id, arm: arm.id, label: arm.label })
  return (
    <div className="eva-bench-table" role="table" aria-label="Tests" data-testid="arms-table">
      <div className="eva-bench-arm eva-bench-thead" role="row">
        <span role="columnheader">Test</span>
        <span role="columnheader" className="eva-bench-cap">
          {detail.primary ?? 'Quality'}
        </span>
        <span role="columnheader">s/test</span>
        <span role="columnheader">Cost/test</span>
        <span role="columnheader">Failures</span>
        <span role="columnheader">Coverage</span>
      </div>
      {arms.map((arm) => {
        const rate = primaryRate(arm, detail.primary)
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
              <span className="eva-bench-run-title">{arm.label}</span>
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
              {arm.cost ? (
                money(arm.cost.perTest, arm.cost.unit)
              ) : (
                <span className="eva-bench-dim">n/a</span>
              )}
            </span>
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
 * `work/experiments`. Runs list, then one run's tests; a test's details open in the side panel.
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

  let body
  if (selected) {
    body = detail ? (
      <RunDetail detail={detail} onBack={() => setSelected(null)} />
    ) : (
      <p className="eva-bench-dim">Loading experiment</p>
    )
  } else if (rows === null) {
    body = error ? (
      <p className="eva-bench-warning" role="alert">
        Could not read work/experiments ({error}).
      </p>
    ) : (
      <p className="eva-bench-dim">Loading experiments</p>
    )
  } else if (rows.length === 0) {
    body = (
      <div className="eva-bench-empty" data-testid="experiments-empty">
        <IconFlask size={24} />
        <h2>No experiments yet</h2>
        <p className="eva-bench-dim">
          Experiments started with bun .omp/tools/exp.ts init show up here as they run.
        </p>
      </div>
    )
  } else {
    body = <RunsList rows={rows} onOpen={setSelected} />
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
