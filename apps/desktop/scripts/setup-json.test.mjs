import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const setup = fileURLToPath(new URL('../resources/setup/', import.meta.url))

test(
  'missing JSON keys return empty output, never plutil diagnostics',
  { skip: process.platform !== 'darwin' },
  () => {
    for (const [input, key, expected] of [
      ['{"name":"Relay"}', 'model', ''],
      ['{"name":"Relay"}', 'name', 'Relay'],
      ['{"port":7817}', 'port', '7817'],
      ['invalid json', 'model', ''],
    ]) {
      const result = spawnSync(
        '/bin/bash',
        ['-c', '. "$1/lib.sh"; json_get "$2"', 'test', setup, key],
        { input, encoding: 'utf8' },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), expected)
    }
  },
)

test(
  'scaffolding without a model uses the default; explicit models are preserved',
  { skip: process.platform !== 'darwin' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-setup-test-'))
    try {
      for (const model of [undefined, 'openai-codex/gpt-5.2']) {
        const root = join(dir, model === undefined ? 'default' : 'explicit')
        const answers = join(dir, 'answers.json')
        writeFileSync(
          answers,
          JSON.stringify({ userName: 'Test', assistants: [{ id: 'relay', name: 'Relay', model }] }),
        )
        const result = spawnSync('/bin/bash', [join(setup, 'scaffold-home.sh'), root, answers], {
          encoding: 'utf8',
          env: { ...process.env, RELAY_SETUP_LOG_DIR: join(dir, 'logs') },
        })
        assert.equal(result.status, 0, result.stdout + result.stderr)
        const registry = JSON.parse(readFileSync(join(root, '.omp/assistant/agents.json'), 'utf8'))
        assert.equal(registry.agents[0].model, model)
        assert.equal(registry.agents[0].scope, undefined)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
