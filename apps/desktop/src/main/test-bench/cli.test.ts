import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BenchRun } from '@evaos/contract'
vi.mock('electron', () => ({ app: {} }))
vi.mock('./browser', () => ({ collectBrowser: vi.fn() }))
import { benchmarkExit, parseCli, runCli } from './cli'
import { createTestBench, type Adjudicator } from './engine'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const args = ['run', '--model', 'jev/jev-1.13.0', '--model', 'openai-codex/gpt-5.6-luna']
const adjudicator: Adjudicator = {
  models: async () => [
    {
      provider: 'jev',
      model: 'jev-1.13.0',
      profile: 'current',
      label: 'Jev',
      resolvedVersion: null,
    },
  ],
  judge: async () => {
    throw new Error('Unavailable test provider')
  },
}
function service(dir = mkdtempSync(join(tmpdir(), 'bench-cli-'))) {
  dirs.push(dir)
  return createTestBench({
    configDir: dir,
    adjudicator,
    collector: async () => {
      throw new Error('Test collector failure')
    },
  })
}
const io = () => ({ out: vi.fn(), progress: vi.fn() })

describe('shared Test Bench CLI', () => {
  it('parses exact model IDs, ordered profiles and validated engine limits', () => {
    const parsed = parseCli([
      'run',
      '--model',
      'jev/jev-1.13.0',
      '--profile',
      'work',
      '--model',
      'provider/model/variant',
      '--judgment-ms',
      '5000',
    ])
    expect(parsed.input!.configurations[1]).toEqual({
      provider: 'provider',
      model: 'model/variant',
      profile: 'work',
    })
    expect(parsed.input!.limits!.judgmentMs).toBe(5000)
    expect(() => parseCli([...args, '--total-ms', '99999999'])).toThrow()
    expect(() => parseCli(['run', '--model', 'missing-provider'])).toThrow()
    expect(() => parseCli(['show'])).toThrow()
    expect(() => parseCli(['list', '--profile', 'work'])).toThrow()
    expect(() => parseCli(['models', '--unknown', 'value'])).toThrow()
  })
  it.each([
    ['completed', [], 'qualified', 0],
    ['completed', [], 'not-qualified', 1],
    ['error', [{ code: 'provider' }], 'not-qualified', 2],
    ['interrupted', [], 'not-qualified', 2],
    ['cancelled', [{ code: 'cancelled' }], 'not-qualified', 130],
    ['cancelled', [{ code: 'provider' }, { code: 'cancelled' }], 'not-qualified', 2],
  ])(
    'uses engine qualification and infrastructure precedence: %s %j',
    (status, errors, inspect, expected) => {
      expect(
        benchmarkExit({ status, errors, scores: [{ split: 'all', inspect }] } as BenchRun),
      ).toBe(expected)
    },
  )
  it('prints machine-readable terminal result and stderr progress; inspects historical failure after reload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cli-reload-'))
    const output = io()
    expect(await runCli(args, service(dir), output, new AbortController().signal)).toBe(2)
    expect(output.progress).toHaveBeenCalled()
    const run = output.out.mock.calls[0]![0] as BenchRun
    expect(JSON.parse(JSON.stringify(run)).status).toBe('error')
    const shown = io()
    expect(await runCli(['show', run.id], service(dir), shown, new AbortController().signal)).toBe(
      0,
    )
    expect(shown.out.mock.calls[0]![0]).toEqual(run)
    const listed = io()
    expect(await runCli(['list'], service(dir), listed, new AbortController().signal)).toBe(0)
    expect(listed.out.mock.calls[0]![0]).toHaveLength(1)
  })
  it('returns catalog JSON without starting a comparison', async () => {
    const output = io()
    expect(await runCli(['models'], service(), output, new AbortController().signal)).toBe(0)
    expect(output.out.mock.calls[0]![0]).toHaveLength(1)
    expect(output.progress).not.toHaveBeenCalled()
  })
  it('returns infrastructure code for invalid/missing IDs and invalid command', async () => {
    for (const command of [
      ['show', '../secret'],
      ['show', '00000000-0000-4000-8000-000000000000'],
      ['unknown'],
    ]) {
      const output = io()
      expect(await runCli(command, service(), output, new AbortController().signal)).toBe(2)
      expect(JSON.stringify(output.out.mock.calls)).not.toContain('../secret')
    }
  })
  it('cancels a started comparison and persists it through the same engine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-cli-cancel-'))
    dirs.push(dir)
    const controller = new AbortController()
    const bench = createTestBench({
      configDir: dir,
      adjudicator,
      collector: async (_fixture, _limits, signal) => {
        const gate = Promise.withResolvers<never>()
        signal.addEventListener('abort', () => gate.reject(new Error('cancelled')), { once: true })
        controller.abort()
        return gate.promise
      },
    })
    const output = io()
    expect(await runCli(args, bench, output, controller.signal)).toBe(130)
    expect(output.out.mock.calls[0]![0].status).toBe('cancelled')
  })
})
