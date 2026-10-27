import type { ArmSummary, ExperimentStatus, QualityMetric } from '@evaos/contract'

/** A 0..1 fraction as a whole percent. */
export function pct(p: number): string {
  return `${Math.round(p * 100)}%`
}

/** `75% (41-93)`: the rate with its 95% Wilson interval. */
export function rateWithInterval(m: QualityMetric): string {
  return `${pct(m.p)} (${Math.round(m.lo * 100)}-${Math.round(m.hi * 100)})`
}

/** Seconds as `0.42s`, `12.5s`, `3m 05s`, `1h 12m`. */
export function duration(s: number): string {
  if (s < 1) return `${s.toFixed(2)}s`
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
}

export function money(value: number, unit: 'usd' | 'tokens'): string {
  if (unit === 'tokens')
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k tokens` : `${Math.round(value)} tokens`
  return `$${value.toFixed(value < 0.01 ? 4 : value < 1 ? 3 : 2)}`
}

export const STATUS_LABEL: Record<ExperimentStatus, string> = {
  planned: 'Planned',
  running: 'Running',
  pass: 'Pass',
  fail: 'Fail',
  inconclusive: 'Inconclusive',
}

/** An arm's rate on the primary metric: holdout when it ran, else dev. */
export function primaryRate(arm: ArmSummary, metric: string | null): QualityMetric | null {
  const rates = (arm.quality ?? []).filter((q) => metric === null || q.metric === metric)
  return rates.find((q) => q.split === 'holdout') ?? rates.find((q) => q.split === 'dev') ?? null
}
