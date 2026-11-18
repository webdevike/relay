// JSON reading in resources/setup/lib.sh (json_get, json_valid) and the scaffold that relies on it.
// Runs on macOS (plutil) and Linux (jq, else bun, else node); each available tool is also forced through
// RELAY_JSON_TOOL so the Linux readers are checked on a Mac too. Run: pnpm test:setup
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { test } from 'node:test'

const setup = fileURLToPath(new URL('../resources/setup/', import.meta.url))
const supported = process.platform === 'darwin' || process.platform === 'linux'

const has = (tool) => spawnSync('bash', ['-c', `command -v ${tool}`]).status === 0
const tools = [...(process.platform === 'darwin' ? ['plutil'] : []), 'jq', 'bun', 'node'].filter(
  has,
)

/** json_get <key> on stdin through lib.sh, with RELAY_JSON_TOOL forced (or the default when empty). */
function jsonGet(tool, input, key) {
  const result = spawnSync('bash', ['-c', '. "$1/lib.sh"; json_get "$2"', 'test', setup, key], {
    input,
    encoding: 'utf8',
    env: { ...process.env, RELAY_JSON_TOOL: tool },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('missing JSON keys return empty output, never diagnostics', { skip: !supported }, () => {
  const doc = JSON.stringify({
    name: 'Relay',
    port: 7817,
    on: true,
    none: null,
    accounts: [{ provider: 'anthropic' }, { provider: 'mcp_oauth:x' }],
    Self: { TailscaleIPs: ['100.1.2.3'] },
  })
  for (const tool of ['', ...tools]) {
    for (const [input, key, expected] of [
      ['{"name":"Relay"}', 'model', ''],
      ['{"name":"Relay"}', 'name', 'Relay'],
      ['{"port":7817}', 'port', '7817'],
      ['invalid json', 'model', ''],
      [doc, 'none', ''],
      [doc, 'on', 'true'],
      [doc, 'accounts', '2'],
      [doc, 'accounts.1.provider', 'mcp_oauth:x'],
      [doc, 'accounts.5.provider', ''],
      [doc, 'name.x', ''],
      [doc, 'Self.TailscaleIPs.0', '100.1.2.3'],
    ]) {
      assert.equal(jsonGet(tool, input, key), expected, `${tool || 'default'}: ${key}`)
    }
  }
})

test(
  'scaffolding without a model uses the default; explicit models are preserved',
  { skip: !supported },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-setup-test-'))
    try {
      for (const tool of ['', ...tools]) {
        for (const model of [undefined, 'openai-codex/gpt-5.2']) {
          const root = join(
            dir,
            `${tool || 'default'}-${model === undefined ? 'default' : 'explicit'}`,
          )
          const answers = join(dir, 'answers.json')
          writeFileSync(
            answers,
            JSON.stringify({
              userName: 'Test',
              assistants: [{ id: 'relay', name: 'Relay', model }],
            }),
          )
          const result = spawnSync('bash', [join(setup, 'scaffold-home.sh'), root, answers], {
            encoding: 'utf8',
            env: { ...process.env, RELAY_SETUP_LOG_DIR: join(dir, 'logs'), RELAY_JSON_TOOL: tool },
          })
          assert.equal(result.status, 0, result.stdout + result.stderr)
          const registry = JSON.parse(
            readFileSync(join(root, '.omp/assistant/agents.json'), 'utf8'),
          )
          assert.equal(registry.agents[0].model, model, tool || 'default')
          assert.equal(registry.agents[0].scope, undefined)
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

test(
  'scaffolding from a read-only template (the Nix store) fills placeholders in writable copies',
  { skip: !supported },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-setup-test-'))
    const template = join(dir, 'starter-home')
    const lock = (path, mode) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        if (entry.isDirectory()) lock(child, mode)
        else chmodSync(child, mode & 0o644)
      }
      chmodSync(path, mode)
    }
    try {
      cpSync(join(setup, 'starter-home'), template, { recursive: true })
      lock(template, 0o555)
      const answers = join(dir, 'answers.json')
      writeFileSync(answers, JSON.stringify({ userName: 'Sam', assistants: [{ name: 'Relay' }] }))
      const root = join(dir, 'home')
      const result = spawnSync('bash', [join(setup, 'scaffold-home.sh'), root, answers], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RELAY_SETUP_LOG_DIR: join(dir, 'logs'),
          RELAY_STARTER_HOME: template,
        },
      })
      assert.equal(result.status, 0, result.stdout + result.stderr)
      const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
      assert.match(agents, /Sam/)
      assert.doesNotMatch(agents, /\{\{userName\}\}/)
    } finally {
      lock(template, 0o755)
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
