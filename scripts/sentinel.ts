// Advisory git-status sentinel (D-25 as amended). The authoritative check that nothing writes
// into the Eva checkout is the runtime write trap in packages/eva-core; this only reports drift.
// Usage: node scripts/sentinel.ts before|after
// Env: EVAOS_SENTINEL_STRICT=1 fails on any difference; EVAOS_SENTINEL_IGNORE=glob,glob skips lines.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const REPOS = ['/Users/ike/Eva', '/Users/ike/Eva/apps/evaos', '/Users/ike/Eva/work/relay']
const phase = process.argv[2]
if (phase !== 'before' && phase !== 'after') {
  console.error('usage: node scripts/sentinel.ts before|after')
  process.exit(2)
}

const globToRe = (g: string): RegExp =>
  new RegExp(
    g
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*'),
  )
const ignores = (process.env.EVAOS_SENTINEL_IGNORE ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(globToRe)

const snapFile = (repo: string): string =>
  path.join(
    os.tmpdir(),
    `evaos-sentinel-${createHash('sha1').update(repo).digest('hex').slice(0, 12)}.json`,
  )

function status(repo: string): string[] | null {
  if (!fs.existsSync(path.join(repo, '.git'))) return null
  try {
    return execFileSync(
      'git',
      ['-C', repo, 'status', '--porcelain=v1', '--untracked-files=normal'],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    )
      .split('\n')
      .filter(Boolean)
  } catch {
    return null
  }
}

const keep = (line: string): boolean =>
  !line.includes('work/evaos-electron') && !ignores.some((re) => re.test(line))

let differences = 0
for (const repo of REPOS) {
  const now = status(repo)
  if (now === null) continue
  const lines = now.filter(keep)
  if (phase === 'before') {
    fs.writeFileSync(snapFile(repo), JSON.stringify(lines))
    continue
  }
  let before: string[]
  try {
    before = JSON.parse(fs.readFileSync(snapFile(repo), 'utf8')) as string[]
  } catch {
    console.log(`SENTINEL: no before snapshot for ${repo}, skipping`)
    continue
  }
  const b = new Set(before)
  const a = new Set(lines)
  for (const l of lines) {
    if (b.has(l)) continue
    differences++
    console.log(`SENTINEL WARNING: ${repo} added: ${l}`)
  }
  for (const l of before) {
    if (a.has(l)) continue
    differences++
    console.log(`SENTINEL WARNING: ${repo} removed: ${l}`)
  }
}
if (phase === 'after') {
  if (differences === 0) console.log('SENTINEL: no changes')
  else if (process.env.EVAOS_SENTINEL_STRICT === '1') process.exit(1)
}
