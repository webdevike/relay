#!/usr/bin/env node
// `pnpm e2e:run [playwright args]`: the `parallel` project (E2E_WORKERS workers, default 4), then
// the `serial` project (timing-sensitive files, one worker, see playwright.config.ts), both always,
// so a failure in the first never hides the second. Exit code: non-zero when either failed.
// Every arg goes to both runs (`--only-changed=<ref>`, `--grep @smoke`, spec paths, `--reporter`);
// a run with nothing to do (all selected tests live in the other project) passes. With an explicit
// `--project`, that one run is the whole thing. E2E_JSON_DIR=<dir> (with `--reporter=json`) writes
// each project's report to <dir>/<project>.json (the nightly job reads them).
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const named = args.some((a) => a === '--project' || a.startsWith('--project=') || a === '-p')
const jsonDir = process.env.E2E_JSON_DIR

const projects = named ? [null] : ['parallel', 'serial']
let status = 0
for (const project of projects) {
  const r = spawnSync(
    'pnpm',
    [
      'exec',
      'playwright',
      'test',
      '--pass-with-no-tests',
      ...(project ? ['--project', project] : []),
      ...args,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: jsonDir
        ? { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: join(jsonDir, `${project ?? 'all'}.json`) }
        : process.env,
    },
  )
  if (r.status !== 0) status = r.status ?? 1
}
process.exit(status)
