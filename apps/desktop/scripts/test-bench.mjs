import { spawn } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import electron from 'electron'

// Keep terminal signals out of Chromium's native startup; cancel through the engine.
const env = { ...process.env, EVAOS_E2E: '1', EVAOS_HIDDEN_WINDOW: '1' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(
  electron,
  [join(import.meta.dirname, '../out/main/test-bench.js'), ...process.argv.slice(2)],
  {
    env,
    stdio: ['pipe', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
  },
)
const cancel = () => {
  if (!child.stdin.destroyed) child.stdin.write('cancel\n')
}
process.on('SIGINT', cancel)
process.on('SIGTERM', cancel)
child.stdin.on('error', () => {})
child.once('error', () => {
  process.stderr.write('Could not start Test Bench. Build EvaOS first.\n')
  process.exitCode = 2
})
child.once('close', (code) => {
  process.removeListener('SIGINT', cancel)
  process.removeListener('SIGTERM', cancel)
  process.exitCode = code ?? 2
})
