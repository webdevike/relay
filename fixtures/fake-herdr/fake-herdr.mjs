#!/usr/bin/env node
// Stand-in for the herdr CLI calls a new chat makes (native herdr.rs), selected with
// EVAOS_HERDR_BIN. No dependencies. Replies are JSON like herdr's: `{"result":...}` on stdout,
// `{"error":{"message":...}}` on stderr with exit 1.
//
//   workspace create|close   a fixed workspace and pane
//   agent start <name> ...   records a planned omp session file in FAKE_HERDR_SESSIONS_DIR (not
//                            created: omp writes it with the first message) and exits 0
//   agent get <name>         that session file as `agent.agent_session.value`, else not found
//
// FAKE_HERDR_STATE: folder for the agents it started. FAKE_HERDR_LOG: JSON lines of every argv.
// FAKE_HERDR_FAIL=create|start: that step fails the way herdr reports it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const STATE = process.env.FAKE_HERDR_STATE ?? join(tmpdir(), 'evaos-fake-herdr')
const SESSIONS = process.env.FAKE_HERDR_SESSIONS_DIR ?? join(STATE, 'sessions')
const LOG = process.env.FAKE_HERDR_LOG

if (LOG) appendFileSync(LOG, JSON.stringify({ t: Date.now(), argv, cwd: process.cwd() }) + '\n')
mkdirSync(STATE, { recursive: true })

const ok = (result) => {
  process.stdout.write(JSON.stringify({ result }) + '\n')
  process.exit(0)
}
const fail = (message) => {
  process.stderr.write(JSON.stringify({ error: { message } }) + '\n')
  process.exit(1)
}
const agentFile = (name) => join(STATE, `agent-${name.replace(/[^\w-]/g, '_')}.json`)

const [group, verb, name] = argv
if (group === 'workspace' && verb === 'create') {
  if (process.env.FAKE_HERDR_FAIL === 'create') fail('no herdr server running')
  ok({ root_pane: { workspace_id: 'w-fake', pane_id: 'p-fake' } })
} else if (group === 'workspace' && verb === 'close') {
  ok({ closed: name })
} else if (group === 'agent' && verb === 'start') {
  if (process.env.FAKE_HERDR_FAIL === 'start') fail('omp exited before it was ready')
  // omp's session file is named the way omp names it; it appears with the first message.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const session = join(SESSIONS, `${stamp}_herdr-${process.pid}.jsonl`)
  writeFileSync(agentFile(name), JSON.stringify({ session, args: argv.slice(argv.indexOf('--') + 1) }))
  ok({ started: name })
} else if (group === 'agent' && verb === 'get') {
  if (!existsSync(agentFile(name))) fail(`agent ${name} not found`)
  const { session } = JSON.parse(readFileSync(agentFile(name), 'utf8'))
  ok({ agent: { name, agent_session: { value: session } } })
} else {
  fail(`fake herdr does not know: ${argv.join(' ')}`)
}
