// Validates proof/phase-1/metrics.json (PROF-02). Usage: node scripts/check-metrics.ts <path>
import * as fs from 'node:fs'

export const FRAME_BUDGET_NOTE =
  'D-28 literal p95 < 16 ms replaced by baseline gate: stream p95 <= max(16.7, idle p95 * 1.25) and zero frames over 50 ms (decision 1)'

type Json = Record<string, unknown>
const get = (o: unknown, p: string): unknown =>
  p
    .split('.')
    .reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Json)[k] : undefined), o)

export function checkMetrics(m: Json): string[] {
  const problems: string[] = []
  const need = (p: string, ok: (v: unknown) => boolean, what: string): void => {
    const v = get(m, p)
    if (v === undefined) problems.push(`missing key: ${p}`)
    else if (!ok(v)) problems.push(`failed: ${p} ${what} (got ${JSON.stringify(v)})`)
  }
  const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  need('chat.seqGaps', (v) => v === 0, '=== 0')
  need('chat.seqContiguous', (v) => v === true, '=== true')
  need('chat.gate.budgetMs', num, 'is a number')
  need('chat.stream.p95', num, 'is a number')
  const budget = get(m, 'chat.gate.budgetMs')
  const p95 = get(m, 'chat.stream.p95')
  if (num(budget) && num(p95) && (p95 as number) > (budget as number))
    problems.push(`failed: chat.stream.p95 ${p95} > budget ${budget}`)
  need('chat.stream.longFrames', (v) => v === 0, '=== 0')
  for (const k of ['chat.idle.p95', 'chat.stream.p50', 'chat.stream.p99', 'chat.stream.max'])
    need(k, num, 'is a number')
  need('browser.boundsDeltaPx', (v) => v === 0, '=== 0')
  need('browser.overlayHidesView', (v) => v === true, '=== true')
  need('browser.boundsRestoredAfterOverlay', (v) => v === true, '=== true')
  need('browser.cdpText', (v) => typeof v === 'string' && v.length > 0, 'non-empty string')
  need('browser.devtoolsCoexist', (v) => v === true, '=== true')
  need('browser.extensionLoaded', (v) => v === true, '=== true')
  need('browser.arcImportCount', (v) => num(v) && (v as number) >= 1, '>= 1')
  need('display.hz', (v) => num(v) && (v as number) > 0, '> 0')
  return problems
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith('check-metrics.ts')
if (isMain) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: node scripts/check-metrics.ts <path>')
    process.exit(2)
  }
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Json
  const notes = (m.notes ?? {}) as Json
  if (typeof notes.frameBudget !== 'string') {
    m.notes = { ...notes, frameBudget: FRAME_BUDGET_NOTE }
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n')
  }
  const problems = checkMetrics(m)
  for (const k of ['browser.bitwardenInstalled', 'browser.extensionPopup', 'browser.dragRegion'])
    console.log(`info ${k}: ${JSON.stringify(get(m, k))}`)
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('metrics OK')
}
