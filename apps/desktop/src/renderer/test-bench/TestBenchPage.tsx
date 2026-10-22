import { useEffect, useRef, useState } from 'react'
import { Button, MultiSelect, SegmentedControl, Select } from '@mantine/core'
import type { Place } from '@evaos/shell-core'
import {
  BENCH_LIMITS,
  type BenchIdentity,
  type BenchModel,
  type BenchProgress,
  type BenchRun,
  type BenchScore,
} from '@evaos/contract'
import { invoke, on } from '../ipc'
import { ScrollArea } from '../ui/ScrollArea'
import { ChatGallery } from './ChatGallery'
import './test-bench.css'

type BenchView = 'models' | 'gallery'
const VIEWS: Array<{ value: BenchView; label: string }> = [
  { value: 'models', label: 'Model comparison' },
  { value: 'gallery', label: 'Chat gallery' },
]

const identity = (m: BenchIdentity): string => `${m.provider}/${m.model} (${m.profile})`
const key = (m: BenchIdentity): string => JSON.stringify([m.provider, m.model, m.profile])
const rate = (r: BenchScore['coverage']): string =>
  `${r.numerator}/${r.denominator}${r.value === null ? ' · unavailable' : ''}`
const message = (error: unknown): string =>
  error instanceof Error ? error.message : 'Test Bench request failed'

function ScoreDetails({ score }: { score: BenchScore }) {
  return (
    <div className="bench-score-details">
      <p>
        Attempted {score.attempted}/{score.planned}; valid {score.evaluable}/{score.planned};
        completed {score.completed}/{score.planned}. Collector failures: {score.collectorFailures}.
      </p>
      <dl className="bench-metrics">
        <div>
          <dt>False passes / defective</dt>
          <dd>{rate(score.falsePasses)}</dd>
        </div>
        <div>
          <dt>Detected / defective</dt>
          <dd>{rate(score.detection)}</dd>
        </div>
        <div>
          <dt>False alarms / clean</dt>
          <dd>{rate(score.falseAlarms)}</dd>
        </div>
        <div>
          <dt>Abstentions / valid</dt>
          <dd>{rate(score.abstentions)}</dd>
        </div>
        <div>
          <dt>Coverage / attempted</dt>
          <dd>{rate(score.coverage)}</dd>
        </div>
        <div>
          <dt>Infrastructure / attempted</dt>
          <dd>{rate(score.infrastructure)}</dd>
        </div>
        <div>
          <dt>Mismatches / valid</dt>
          <dd>{rate(score.mismatches)}</dd>
        </div>
      </dl>
      <div className="bench-table-wrap">
        <table>
          <caption>Category denominators ({score.split})</caption>
          <thead>
            <tr>
              <th>Category</th>
              <th>Planned</th>
              <th>Valid</th>
              <th>Errors</th>
              <th>Unattempted</th>
              <th>Mismatches / valid</th>
            </tr>
          </thead>
          <tbody>
            {score.categories.map((c) => (
              <tr key={c.category}>
                <th>{c.category}</th>
                <td>{c.planned}</td>
                <td>{c.valid}</td>
                <td>{c.infrastructure}</td>
                <td>{c.unattempted}</td>
                <td>{rate(c.mismatches)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {score.criticalFalsePasses.length > 0 && (
        <p role="alert">
          Critical false passes veto Inspect qualification: {score.criticalFalsePasses.join(', ')}
        </p>
      )}
    </div>
  )
}

function Evidence({ run }: { run: BenchRun }) {
  const [caseId, setCaseId] = useState(run.cases[0]?.id ?? '')
  const [configId, setConfigId] = useState(run.configurations[0]?.id ?? '')
  const [images, setImages] = useState<string[]>([])
  const [error, setError] = useState('')
  const item = run.cases.find((c) => c.id === caseId)
  const evidence = item?.evidence
  const judgment = item?.judgments.find((j) => j.configId === configId)
  useEffect(() => {
    let live = true
    setImages([])
    setError('')
    if (evidence)
      void Promise.all(
        [evidence.beforeId, evidence.afterId].map(async (evidenceId) => {
          const result = await invoke('testBench.evidence', { runId: run.id, evidenceId })
          if (!result.ok) throw new Error(result.error.message)
          return result.value.dataUrl
        }),
      )
        .then((value) => {
          if (live) setImages(value)
        })
        .catch((e) => {
          if (live) setError(message(e))
        })
    return () => {
      live = false
    }
  }, [run.id, evidence?.beforeId, evidence?.afterId])
  return (
    <section aria-label="Case evidence" className="bench-section">
      <h3>Case evidence</h3>
      <div className="bench-controls">
        <Select
          label="Case"
          value={caseId}
          onChange={(v) => v && setCaseId(v)}
          data={run.cases.map((c, i) => ({
            value: c.id,
            label: `${i + 1}. ${c.category} · ${c.split} · ${c.id}`,
          }))}
          searchable
        />
        <Select
          label="Evidence configuration"
          value={configId}
          onChange={(v) => v && setConfigId(v)}
          data={run.configurations.map((c) => ({ value: c.id, label: identity(c) }))}
        />
      </div>
      <p>
        Expected: {item?.expected}. Severity: {item?.severity}. Judgment:{' '}
        {judgment?.status ?? 'unattempted'}.
      </p>
      {item?.error && (
        <p role="alert">
          Collection {item.error.code}: {item.error.message}
        </p>
      )}
      {judgment?.error && (
        <p role="alert">
          {judgment.error.code}: {judgment.error.message}
        </p>
      )}
      {!evidence ? (
        <p>Evidence unavailable. This case was not collected successfully.</p>
      ) : (
        <>
          <h4>{evidence.envelope.criterion}</h4>
          <p>
            Missing evidence: {evidence.envelope.missing.join(', ') || 'None reported'}. Captured{' '}
            {evidence.collectedAt}, {evidence.durationMs} ms.
          </p>
          <details>
            <summary>Deterministic observations and evidence digest</summary>
            <pre>{JSON.stringify(evidence.envelope.observations, null, 2)}</pre>
            <code>{evidence.digest}</code>
          </details>
          <p className="bench-muted">
            Captured proof only. Models receive identical text observations, not these images.
          </p>
          {error && <p role="alert">{error}</p>}
          {!error && images.length === 0 && <p role="status">Loading captured proof…</p>}
          <div className="bench-images">
            {images.map((src, i) => (
              <figure key={i === 0 ? evidence.beforeId : evidence.afterId}>
                <figcaption>{i === 0 ? 'Before' : 'After'}: captured PNG</figcaption>
                <img src={src} alt={`${i === 0 ? 'Before' : 'After'} captured settings form`} />
              </figure>
            ))}
          </div>
        </>
      )}
      {judgment?.answer && (
        <div className="bench-section">
          <h4>Validated verdict: {judgment.answer.decision}</h4>
          <p>{judgment.answer.rationale}</p>
          <p>
            Requested: {identity(judgment.answer.requested)}
            <br />
            Returned:{' '}
            {judgment.answer.returned ? identity(judgment.answer.returned) : 'Unavailable'}
            <br />
            Resolved version: {judgment.answer.resolvedVersion ?? 'Unavailable (alias unresolved)'}
          </p>
          <p>
            Started: {judgment.startedAt ?? 'Unavailable'}; duration:{' '}
            {judgment.durationMs ?? 'Unavailable'} ms. Input tokens:{' '}
            {judgment.answer.usage?.inputTokens ?? 'Unavailable'}; output tokens:{' '}
            {judgment.answer.usage?.outputTokens ?? 'Unavailable'}; cost:{' '}
            {judgment.answer.cost ?? 'Unavailable'}.
          </p>
          <details>
            <summary>Raw verdict (bounded)</summary>
            <pre>{judgment.answer.raw}</pre>
          </details>
        </div>
      )}
    </section>
  )
}

function Results({ run }: { run: BenchRun }) {
  const incomplete = run.status !== 'completed'
  return (
    <section aria-label="Comparison results" className="bench-section" data-testid="bench-results">
      <div>
        <h2>Comparison results</h2>
        <p className="bench-muted">
          {run.status}
          {incomplete ? ' · incomplete' : ''} · {new Date(run.createdAt).toLocaleString()}
        </p>
      </div>
      <details>
        <summary>Run details</summary>
        <p>{run.id}</p>
        <p>
          Started {run.createdAt}. Finished {run.finishedAt ?? 'Not finished'}.
        </p>
      </details>
      {run.errors.map((e, i) => (
        <p role="alert" key={i}>
          {e.code}: {e.message}
          {e.caseId ? ` (case ${e.caseId})` : ''}
        </p>
      ))}
      <div className="bench-table-wrap">
        <table aria-label="Configuration comparison">
          <thead>
            <tr>
              <th>Configuration</th>
              <th>Critical false passes</th>
              <th>Detection / defective</th>
              <th>Valid / planned</th>
              <th>Inspect</th>
            </tr>
          </thead>
          <tbody>
            {run.configurations.map((c) => {
              const score = run.scores.find((s) => s.configId === c.id && s.split === 'all')
              return (
                <tr key={c.id}>
                  <th>{identity(c)}</th>
                  <td>{score?.criticalFalsePasses.length ?? 'Unavailable'}</td>
                  <td>{score ? rate(score.detection) : 'Unavailable'}</td>
                  <td>{score ? `${score.evaluable}/${score.planned}` : 'Unavailable'}</td>
                  <td>
                    {score?.inspect === 'qualified'
                      ? 'Benchmark qualified'
                      : incomplete
                        ? 'Incomplete'
                        : 'Not qualified'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="bench-muted">
        Inspect is scoped to this settings-form benchmark. It does not establish production safety
        or grant permissions.
      </p>
      <div className="bench-ladder" aria-label="Capability ladder">
        <span>Inspect: see configuration results</span>
        <span>Repair: Unassessed</span>
        <span>Build: Unassessed</span>
        <span>Delegate: Unassessed</span>
      </div>
      {run.configurations.map((c) => (
        <details key={c.id}>
          <summary>{identity(c)}: scorecards and configuration</summary>
          <p>
            Configuration: <code>{c.id}</code>
          </p>
          <p>
            Track: {c.track}. Rubric: {c.rubric.version} (<code>{c.rubric.hash}</code>). Skill:{' '}
            {c.skill.version} (<code>{c.skill.hash}</code>).
          </p>
          <p>
            Fixture: {run.fixtureVersion} (<code>{run.fixtureHash}</code>).
          </p>
          <details>
            <summary>Bounded rubric, skill and limits</summary>
            <pre>
              {JSON.stringify({ rubric: c.rubric, skill: c.skill, limits: c.limits }, null, 2)}
            </pre>
          </details>
          {run.scores
            .filter((s) => s.configId === c.id)
            .map((s) => (
              <section key={s.split}>
                <h4>{s.split}</h4>
                <ScoreDetails score={s} />
              </section>
            ))}
        </details>
      ))}
      <details>
        <summary>Inspect case evidence and verdicts</summary>
        <Evidence run={run} />
      </details>
    </section>
  )
}

export function TestBenchPage(_props: { place: Place }) {
  const [models, setModels] = useState<BenchModel[] | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [catalogError, setCatalogError] = useState('')
  const [history, setHistory] = useState<BenchRun[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [run, setRun] = useState<BenchRun | null>(null)
  const [progress, setProgress] = useState<BenchProgress | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const [view, setView] = useState<BenchView>('models')
  const selectedRun = useRef<string | null>(null)
  const generation = useRef(0)
  async function loadModels() {
    setCatalogError('')
    setModels(null)
    try {
      const result = await invoke('testBench.models', {})
      if (!mounted.current) return
      if (!result.ok) throw new Error(result.error.message)
      setModels(result.value)
      setSelected((old) => old.filter((k) => result.value.some((m) => key(m) === k)))
    } catch (e) {
      if (mounted.current) setCatalogError(message(e))
    }
  }
  async function loadHistory() {
    const request = ++generation.current
    try {
      const result = await invoke('testBench.list', {})
      if (!mounted.current || request !== generation.current) return
      if (!result.ok) throw new Error(result.error.message)
      setHistory(result.value)
      setHistoryError('')
      const active = result.value.find((r) => r.status === 'running')
      setActiveId(active?.id ?? null)
      const next =
        result.value.find((r) => r.id === selectedRun.current) ?? active ?? result.value[0]
      if (next) {
        selectedRun.current = next.id
        setRun(next)
      }
    } catch (e) {
      if (mounted.current) setHistoryError(message(e))
    }
  }
  useEffect(() => {
    mounted.current = true
    const unsubscribe = on('testBench.progress', (value) => {
      if (!mounted.current) return
      setProgress(value)
      setActiveId(value.status === 'running' ? value.runId : null)
      void loadHistory()
    })
    void loadModels()
    void loadHistory()
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [])
  async function start() {
    setBusy(true)
    setError('')
    try {
      const configurations = (models ?? [])
        .filter((m) => selected.includes(key(m)))
        .map(({ provider, model, profile }) => ({ provider, model, profile }))
      const result = await invoke('testBench.start', { configurations })
      if (!result.ok) throw new Error(result.error.message)
      selectedRun.current = result.value.runId
      if (mounted.current) {
        setActiveId(result.value.runId)
        await loadHistory()
      }
    } catch (e) {
      if (mounted.current) setError(message(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function cancel() {
    if (!activeId) return
    setBusy(true)
    setError('')
    try {
      const result = await invoke('testBench.cancel', { runId: activeId })
      if (!result.ok) throw new Error(result.error.message)
      await loadHistory()
    } catch (e) {
      if (mounted.current) setError(message(e))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function openRun(id: string | null) {
    if (!id) return
    selectedRun.current = id
    setError('')
    try {
      const result = await invoke('testBench.get', { runId: id })
      if (!mounted.current || selectedRun.current !== id) return
      if (!result.ok) throw new Error(result.error.message)
      setRun(result.value)
    } catch (e) {
      if (mounted.current) setError(message(e))
    }
  }
  // The comparison stays mounted while the gallery shows, so a running trial keeps its state.
  return (
    <ScrollArea scrollKey="page:test-bench" className="bench-scroll" data-testid="page-test-bench">
      <main className="bench-page">
        <header>
          <h1>Test Bench</h1>
          <SegmentedControl
            aria-label="Test Bench view"
            data-testid="bench-view"
            value={view}
            onChange={(v) => setView(v as BenchView)}
            data={VIEWS}
          />
          {view === 'models' ? (
            <p className="bench-muted">UI/UX · settings-form · 24 cases</p>
          ) : null}
        </header>
        <div className="bench-view" hidden={view !== 'models'}>
          <details open={!run || !!activeId} className="bench-setup">
            <summary>Run a comparison</summary>
            <section className="bench-section" aria-label="Run comparison">
              <p className="bench-muted">
                Choose 2 to 4 models. Each receives the same browser observations.
              </p>
              <MultiSelect
                label="Model configurations"
                placeholder={
                  catalogError
                    ? 'Model discovery unavailable'
                    : models === null
                      ? 'Discovering models…'
                      : 'Select exact models and accounts'
                }
                searchable
                value={selected}
                onChange={setSelected}
                maxValues={4}
                disabled={!!activeId || busy || !models?.length}
                data={(models ?? []).map((m) => ({ value: key(m), label: identity(m) }))}
              />
              {catalogError && (
                <p role="alert">
                  Model discovery: {catalogError}. Saved comparisons remain available.
                </p>
              )}
              {models?.length === 0 && <p>No models available through existing credentials.</p>}
              <div className="bench-actions">
                <Button
                  onClick={() => void start()}
                  disabled={
                    busy || !!activeId || selected.length < 2 || selected.length > 4 || !models
                  }
                >
                  Run comparison
                </Button>
                <Button
                  variant="subtle"
                  onClick={() => void loadModels()}
                  disabled={!!activeId || busy}
                >
                  Refresh models
                </Button>
                {activeId && (
                  <Button variant="outline" onClick={() => void cancel()} disabled={busy}>
                    Cancel run
                  </Button>
                )}
              </div>
              <details>
                <summary>Trial and execution limits</summary>
                <p>
                  16 development and 8 holdout cases. Versioned rubric and skill hashes are saved
                  with each configuration.
                </p>
                <p>
                  Capture {BENCH_LIMITS.captureMs / 1000}s; judgment{' '}
                  {BENCH_LIMITS.judgmentMs / 1000}
                  s; total {BENCH_LIMITS.totalMs / 60000} minutes. Input{' '}
                  {BENCH_LIMITS.envelopeBytes} bytes; raw verdict {BENCH_LIMITS.rawBytes} bytes; PNG{' '}
                  {BENCH_LIMITS.pngBytes} bytes.
                </p>
              </details>
            </section>
          </details>
          {error && <p role="alert">{error}</p>}
          {activeId && (
            <p role="status">
              Running comparison {activeId}.{' '}
              {progress?.runId === activeId
                ? `${progress.completed}/${progress.planned} judgments complete. Case ${progress.caseId ?? 'preparing'}, configuration ${progress.configId ?? 'preparing'}.`
                : 'Preparing evidence.'}
            </p>
          )}
          {progress && progress.status !== 'running' && (
            <p role="status">
              Latest run: {progress.status}, {progress.completed}/{progress.planned} judgments
              complete.
            </p>
          )}
          <section className="bench-section" aria-label="Saved comparisons">
            <div className="bench-actions">
              <Button variant="subtle" onClick={() => void loadHistory()}>
                Refresh history
              </Button>
            </div>
            {historyError && <p role="alert">History: {historyError}</p>}
            {!history && !historyError && <p role="status">Loading saved comparisons…</p>}
            {history?.length === 0 && (
              <p>No saved comparisons. Select two configurations to run the trial.</p>
            )}
            {!!history?.length && (
              <Select
                label="Saved comparison"
                value={run?.id ?? null}
                onChange={(id) => void openRun(id)}
                searchable
                data={history.map((r) => ({
                  value: r.id,
                  label: `${new Date(r.createdAt).toLocaleString()} · ${r.status}`,
                }))}
              />
            )}
          </section>
          {run ? (
            <Results run={run} key={run.id} />
          ) : (
            <div className="bench-ladder" aria-label="Capability ladder">
              <span>Inspect: Not yet assessed</span>
              <span>Repair: Unassessed</span>
              <span>Build: Unassessed</span>
              <span>Delegate: Unassessed</span>
            </div>
          )}
        </div>
      </main>
      {view === 'gallery' ? <ChatGallery /> : null}
    </ScrollArea>
  )
}
