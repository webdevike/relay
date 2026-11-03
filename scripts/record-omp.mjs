#!/usr/bin/env node
// Records one real omp rpc-ui turn on a THROWAWAY session (temp cwd + temp session dir).
// Never touches ~/.omp/agent/sessions, never passes --resume, never signals omp (closes stdin to end it).
// Usage: node scripts/record-omp.mjs <rawLogOut.jsonl>   (raw log is written outside the repo; scrub separately)
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? join(tmpdir(), 'omp-raw-record.jsonl')
const base = mkdtempSync(join(tmpdir(), 'omp-record-'))
const cwd = join(base, 'cwd')
const sessionDir = join(base, 'sessions')
import { mkdirSync } from 'node:fs'
mkdirSync(cwd)
mkdirSync(sessionDir)

const child = spawn(
  'omp',
  [
    '--mode',
    'rpc-ui',
    '--session-dir',
    sessionDir,
    '--model',
    'haiku',
    '--thinking',
    'off',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-lsp',
    '--no-title',
  ],
  { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
)
const log = []
const t0 = Date.now()
let carry = ''
let settled = 0
let exitCode = null
const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
child.stdout.setEncoding('utf8')
child.stdout.on('data', (d) => {
  carry += d
  let i
  while ((i = carry.indexOf('\n')) >= 0) {
    const line = carry.slice(0, i)
    carry = carry.slice(i + 1)
    if (!line.trim()) continue
    log.push({ t: Date.now() - t0, line })
    let f
    try {
      f = JSON.parse(line)
    } catch {
      continue
    }
    if (f.type === 'session_settled') {
      settled++
      if (settled === 1)
        setTimeout(() => {
          send({
            type: 'prompt',
            id: 'rec-3',
            message: 'Write a long numbered list of 30 fun facts about octopuses, one per line.',
            streamingBehavior: 'steer',
          })
          setTimeout(() => send({ type: 'abort', id: 'rec-4' }), 1500)
        }, 300)
      else setTimeout(() => child.stdin.end(), 500)
    }
  }
})
child.stderr.on('data', () => {})
child.on('exit', (c) => {
  exitCode = c
  finish()
})
let done = false
function finish() {
  if (done) return
  done = true
  writeFileSync(out, log.map((l) => JSON.stringify(l)).join('\n') + '\n')
  console.log(JSON.stringify({ out, frames: log.length, exitCode, base }))
}
send({ type: 'set_ask_dialog', enabled: true, id: 'rec-1' })
send({ type: 'get_state', id: 'rec-2' })
setTimeout(
  () =>
    send({
      type: 'prompt',
      id: 'rec-p1',
      message:
        'Reply with exactly two short sentences about fox habits. Then include a tiny TypeScript code fence (3 lines) and end with the rocket emoji 🚀.',
      streamingBehavior: 'steer',
    }),
  800,
)
setTimeout(() => {
  if (!done) {
    child.stdin.end()
    setTimeout(finish, 10000)
  }
}, 120000)
