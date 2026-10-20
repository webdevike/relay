import { test, expect, launchApp } from './fixtures'
import { proofShot } from './helpers/proofShot'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BenchRunSchema } from '@evaos/contract'
import type {} from '../src/renderer/env'

test.use({ startOnChat: false })

test('Test Bench navigation, exact catalog selection and explicit provider failure (test doubles)', async ({
  app,
  shell,
}) => {
  // Only the test installs these boundary doubles. Production never receives fake catalog data.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('testBench.models')
    ipcMain.handle('testBench.models', () => ({
      ok: true,
      value: [
        {
          provider: 'test',
          model: 'exact-a',
          profile: 'current',
          label: 'A',
          resolvedVersion: null,
        },
        { provider: 'test', model: 'exact-b', profile: 'work', label: 'B', resolvedVersion: null },
      ],
    }))
    ipcMain.removeHandler('testBench.start')
    ipcMain.handle('testBench.start', () => ({
      ok: false,
      error: { code: 'provider', message: 'Test-only isolation rejection' },
    }))
  })
  await shell.getByTestId('nav-test-bench').click()
  await expect(shell.getByTestId('page-test-bench')).toBeVisible()
  const picker = shell.getByRole('combobox', { name: 'Model configurations' })
  await picker.click()
  await shell.getByRole('option', { name: 'test/exact-a (current)' }).click()
  await picker.click()
  await shell.getByRole('option', { name: 'test/exact-b (work)' }).click()
  await picker.press('Escape')
  await shell.getByRole('button', { name: 'Run comparison' }).click()
  await expect(shell.getByRole('alert')).toContainText('Test-only isolation rejection')
  await expect(shell.getByText('Repair: Unassessed')).toBeVisible()
  await shell.getByTestId('nav-jobs').click()
  await shell.getByTestId('nav-test-bench').click()
  await expect(shell.getByTestId('page-test-bench')).toBeVisible()
})

test('real parent-generated comparison is readable offline, with captured PNGs and restart restoration', async () => {
  test.setTimeout(120_000)
  const source = process.env.TEST_BENCH_PROOF_CONFIG
  test.skip(
    !source,
    'Set TEST_BENCH_PROOF_CONFIG to the stable directory containing parent-generated real comparisons. This test never substitutes model doubles for real proof.',
  )
  const sourceRuns = join(source!, 'test-bench', 'runs')
  const candidates = readdirSync(sourceRuns).map((id) => {
    const run = BenchRunSchema.parse(
      JSON.parse(readFileSync(join(sourceRuns, id, 'run.json'), 'utf8')),
    )
    return run
  })
  const chosen = candidates.find(
    (r) =>
      r.status === 'completed' &&
      r.configurations.some((c) => c.provider === 'jev') &&
      r.configurations.some((c) => c.provider !== 'jev') &&
      r.cases.every((c) => c.evidence && c.judgments.every((j) => j.status === 'valid')),
  )
  expect(
    chosen,
    'Real completed Jev + omp comparison with 24 collected cases is required',
  ).toBeTruthy()
  const config = mkdtempSync(join(tmpdir(), 'bench-real-ui-proof-'))
  mkdirSync(join(config, 'test-bench', 'runs'), { recursive: true })
  cpSync(join(sourceRuns, chosen!.id), join(config, 'test-bench', 'runs', chosen!.id), {
    recursive: true,
  })
  // Deliberately invalid discovery routes prove saved history is independent of authentication.
  const env = { EVAOS_OMP_BIN: '/nonexistent-test-bench-omp', TYPESAFE_API_KEY: '' }
  let app = await launchApp(config, env)
  try {
    let shell = await app.firstWindow()
    await shell.getByTestId('nav-test-bench').click()
    await expect(shell.getByTestId('bench-results')).toContainText(chosen!.id)
    await expect(shell.getByRole('table', { name: 'Configuration comparison' })).toBeVisible()
    await proofShot(app, shell, 'test-bench-real-comparison', { phase: 'test-bench' })
    await shell.getByText('Inspect case evidence and verdicts', { exact: true }).click()
    const image = shell.getByRole('img', { name: 'Before captured settings form' })
    await expect(image).toBeVisible()
    await expect
      .poll(() =>
        image.evaluate((node) => node instanceof HTMLImageElement && node.naturalWidth > 0),
      )
      .toBe(true)
    await shell.getByText('Raw verdict (bounded)', { exact: true }).click()
    await expect(shell.getByText('Validated verdict:', { exact: false })).toBeVisible()
    await proofShot(app, shell, 'test-bench-real-evidence', { phase: 'test-bench' })
    await app.close()
    app = await launchApp(config, env)
    shell = await app.firstWindow()
    await expect(shell.getByTestId('page-test-bench')).toBeVisible()
    await expect(shell.getByTestId('bench-results')).toContainText(chosen!.id)
    const result = await shell.evaluate(
      async (runId) => window.eva.invoke('testBench.get', { runId }),
      chosen!.id,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual(chosen)
    await proofShot(app, shell, 'test-bench-real-restart', { phase: 'test-bench' })
  } finally {
    await app.close()
    rmSync(config, { recursive: true, force: true })
  }
})

test.describe('live-mode startup ordering', () => {
  test.use({ launchEnv: { EVAOS_LIVE: '1' }, startOnChat: false })
  test('registers IPC before the renderer loads while preserving fixture isolation', async ({
    shell,
  }) => {
    await shell.getByTestId('nav-test-bench').click()
    await expect(shell.getByTestId('page-test-bench')).toBeVisible()
    const info = await shell.evaluate(() => window.eva.invoke('app.info', {}))
    expect(info.ok).toBe(true)
  })
})
