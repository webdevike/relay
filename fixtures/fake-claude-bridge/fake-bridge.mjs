#!/usr/bin/env node
// Claude bridge stand-in. Translates bridge argv (--rpc, --no-relay, --resume f) to fake-omp argv and
// delegates with inherited stdio. Logs the invocation to FAKE_OMP_LOG. Test-only; never signals anything.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const LOG = process.env.FAKE_OMP_LOG
if (LOG) {
  try {
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), event: 'claude-bridge', detail: { argv } }) + '\n')
  } catch {
    /* ignore */
  }
}

const i = argv.indexOf('--resume')
const resume = i >= 0 ? argv[i + 1] : undefined
// fake-omp only implements rpc-ui, so both bridge shapes (with or without --no-relay) map to it.
const args = [join(here, '../fake-omp/fake-omp.mjs'), '--mode', 'rpc-ui']
if (resume) args.push('--resume', resume)

const child = spawn(process.execPath, args, { stdio: 'inherit', env: process.env })
child.on('exit', (code) => process.exit(code ?? 0))
