// Spacing lint: runs stylelint.config.mjs (padding, margin and gap on Mantine's spacing scale)
// over the renderer CSS. The chat list must be clean. Elsewhere, older violations are listed in
// scripts/spacing-baseline.json, which may only shrink: a new violation fails, and so does a
// baseline entry that no longer occurs (delete it, or run with --update once fixes land).
//
//   node scripts/lint-spacing.ts            check
//   node scripts/lint-spacing.ts --update   rewrite the baseline; refuses to add entries
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import stylelint from 'stylelint'

const ROOT = path.resolve(import.meta.dirname, '..')
const FILES = 'apps/desktop/src/renderer/**/*.css'
const BASELINE = path.join(ROOT, 'scripts/spacing-baseline.json')
/** Directories that may not carry baseline entries at all. */
export const STRICT = ['apps/desktop/src/renderer/chat/list/']

/** file -> "property: value" -> count. */
export type Counts = Record<string, Record<string, number>>

export interface Verdict {
  /** In a strict directory: never allowed. */
  strict: string[]
  /** More occurrences than the baseline allows. */
  added: string[]
  /** Baseline entries that no longer occur as often as listed. */
  stale: string[]
}

export function compare(actual: Counts, baseline: Counts): Verdict {
  const v: Verdict = { strict: [], added: [], stale: [] }
  for (const [file, entries] of Object.entries(actual)) {
    for (const [decl, n] of Object.entries(entries)) {
      if (STRICT.some((d) => file.startsWith(d))) {
        v.strict.push(`${file}: ${decl}${n > 1 ? ` (x${n})` : ''}`)
        continue
      }
      const allowed = baseline[file]?.[decl] ?? 0
      if (n > allowed) v.added.push(`${file}: ${decl} (${n}, baseline ${allowed})`)
    }
  }
  for (const [file, entries] of Object.entries(baseline)) {
    for (const [decl, n] of Object.entries(entries)) {
      const seen = actual[file]?.[decl] ?? 0
      if (seen < n) v.stale.push(`${file}: ${decl} (baseline ${n}, now ${seen})`)
    }
  }
  return v
}

const MESSAGE = /value "([\s\S]*)" for property "([^"]*)"/

/** Lints the renderer CSS and counts each disallowed declaration per file. */
export async function collect(): Promise<Counts> {
  const result = await stylelint.lint({
    files: FILES,
    cwd: ROOT,
    configFile: path.join(ROOT, 'stylelint.config.mjs'),
  })
  const counts: Counts = {}
  for (const r of result.results) {
    const file = path.relative(ROOT, r.source ?? '')
    for (const w of r.warnings) {
      const m = MESSAGE.exec(w.text)
      const decl = (m ? `${m[2]}: ${m[1]}` : w.text).replace(/\s+/g, ' ')
      const entries = (counts[file] ??= {})
      entries[decl] = (entries[decl] ?? 0) + 1
    }
  }
  return counts
}

function sorted(c: Counts): Counts {
  const out: Counts = {}
  for (const file of Object.keys(c).sort()) {
    out[file] = Object.fromEntries(Object.entries(c[file]!).sort(([a], [b]) => a.localeCompare(b)))
  }
  return out
}

async function main(): Promise<void> {
  const actual = await collect()
  const baseline = fs.existsSync(BASELINE)
    ? (JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Counts)
    : {}
  const v = compare(actual, baseline)
  if (process.argv.includes('--update')) {
    if (v.strict.length || v.added.length) {
      console.error('spacing lint: --update only shrinks the baseline; fix these first:')
      for (const l of [...v.strict, ...v.added]) console.error(`  ${l}`)
      process.exit(1)
    }
    fs.writeFileSync(BASELINE, `${JSON.stringify(sorted(actual), null, 2)}\n`)
    console.log('spacing lint: baseline rewritten')
    return
  }
  const report = (title: string, lines: string[]): void => {
    if (!lines.length) return
    console.error(`spacing lint: ${title}`)
    for (const l of lines) console.error(`  ${l}`)
  }
  report('the chat list must use Mantine spacing only', v.strict)
  report('new violations (use 0, var(--mantine-spacing-*) or var(--eva-gap))', v.added)
  report('stale baseline entries (remove them or run with --update)', v.stale)
  if (v.strict.length || v.added.length || v.stale.length) process.exit(1)
  console.log('spacing lint: ok')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
