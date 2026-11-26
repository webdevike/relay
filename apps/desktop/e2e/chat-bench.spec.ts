import * as os from 'node:os'
import type { Page } from '@playwright/test'
import {
  installLongFrameObserver,
  longAnimationFrames,
  percentiles,
  startFrameSampler,
  stopFrameSampler,
} from './helpers/frames'
import { recordMetrics } from './helpers/metrics'
import { proofShot } from './helpers/proofShot'
import { test, expect } from './fixtures'

test.use({ launchEnv: { FAKE_OMP_RECORDING: 'long-turn', FAKE_OMP_DELAY_MS: '16' } })

/** Above this 1-minute load average per core the host is busy with other work. */
const BUSY_LOAD_PER_CPU = 0.7
const hostLoad = (): number => os.loadavg()[0]! / os.cpus().length

const gap = (shell: Page): Promise<number> =>
  shell.evaluate(() => {
    const sc = document.querySelector('[data-testid=chat-log]')!.firstElementChild as HTMLElement
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight
  })
const scrollTop = (shell: Page): Promise<number> =>
  shell.evaluate(
    () =>
      (document.querySelector('[data-testid=chat-log]')!.firstElementChild as HTMLElement)
        .scrollTop,
  )
// Published by the drain on its first batch, so it is absent until something has streamed or resynced.
const chatStats = (shell: Page): Promise<{ batches: number; gaps: number; lastSeq: number }> =>
  shell.evaluate(
    () =>
      (
        window as unknown as {
          __evaosChatStats?: Record<string, { batches: number; gaps: number; lastSeq: number }>
        }
      ).__evaosChatStats?.['pane-1'] ?? { batches: 0, gaps: 0, lastSeq: 0 },
  )
const dot = (shell: Page) =>
  shell.locator('[data-testid=chat-header] [aria-label="Eva is replying"]')

test('chat benchmark: 5,000 messages, pinned follow, pills, frame-time vs idle baseline', async ({
  shell,
  app,
}) => {
  test.setTimeout(120_000)
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', {
      name: /^Benchmark 5000(?:,|$)/,
    })
    .click()
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('LAST-MESSAGE-MARKER')
  await expect.poll(() => gap(shell)).toBeLessThan(24)
  await shell.evaluate(() => {
    ;(window as unknown as { __evaosChatProfile: number[] }).__evaosChatProfile = []
  })

  // Quiesce: the extension host (host.ready), the 5,000-row load and its GC must settle before
  // anything is sampled, so a stray startup frame never lands inside a measured window.
  await shell.waitForTimeout(2500)
  // Warm-up: a second of unmeasured rAF activity so the compositor is in steady state.
  await startFrameSampler(shell)
  await shell.waitForTimeout(1000)
  await stopFrameSampler(shell)
  // A batch main emits between chat.open and the pane registering is dropped, and the stream
  // resyncs from a snapshot (a counted gap). That is the designed recovery of the open, not of
  // the stream, and under load the window widens: only gaps during streaming are failures.
  const gapsBeforeStream = (await chatStats(shell)).gaps

  // Idle baseline, same run, same window (longer than before so one stray frame is visible).
  await startFrameSampler(shell)
  await shell.waitForTimeout(5000)
  const idleSamples = await stopFrameSampler(shell)
  const idle = percentiles(idleSamples)
  const idleLong = idleSamples.slice(10).filter((d) => d > 50).length

  // Streaming while pinned.
  const box = shell.locator('[data-testid=composer-input]')
  // The 1-minute load average per core, before and after the stream (it lags, so both count).
  const loadBefore = hostLoad()
  await installLongFrameObserver(shell)
  await startFrameSampler(shell)
  await box.fill('Stream a long reply')
  await box.press('Enter')
  await expect(dot(shell)).toBeVisible()
  await expect(shell.locator('[data-testid=pill-jump], [data-testid=pill-new-reply]')).toHaveCount(
    0,
  )
  let pinnedGapPx = 0
  let streamShot = false
  let frames: number[] = []
  while (await dot(shell).isVisible()) {
    const g = await gap(shell)
    pinnedGapPx = Math.max(pinnedGapPx, g)
    if (!streamShot) {
      streamShot = true
      // The capture itself blocks frames, so it is taken outside the sampled window.
      frames = frames.concat(await stopFrameSampler(shell))
      await proofShot(app, shell, 'chat-streaming')
      // Let the capture's compositor work drain before sampling resumes.
      await shell.waitForTimeout(400)
      await startFrameSampler(shell)
    }
    await shell.waitForTimeout(500)
  }
  frames = frames.concat(await stopFrameSampler(shell))
  const hostBusy = Math.max(loadBefore, hostLoad()) > BUSY_LOAD_PER_CPU
  const stream = percentiles(frames)
  const longList = frames.slice(10).filter((d) => d > 50)
  const longFrames = longList.length
  if (longFrames > 0) console.log(`LONG FRAMES (ms): ${longList.join(', ')}`)
  const lafs = await longAnimationFrames(shell)
  const profile = await shell.evaluate(
    () => (window as unknown as { __evaosChatProfile?: number[] }).__evaosChatProfile ?? [],
  )
  const prof = percentiles([...Array(10).fill(0), ...profile])
  expect(pinnedGapPx).toBeLessThanOrEqual(1)
  await expect(log).toContainText('Foxes hunt at dusk')

  // Release: scroll up 3,000 px, the Jump pill shows, then output flips it to New reply.
  const rect = (await log.boundingBox())!
  await shell.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await shell.mouse.wheel(0, -3000)
  await expect(shell.locator('[data-testid=pill-jump]')).toBeVisible()
  await expect(shell.locator('[data-testid=pill-new-reply]')).toHaveCount(0)
  await proofShot(app, shell, 'chat-jump-to-latest')
  const jumpPillShown = true

  await box.fill('Again please')
  await box.press('Enter')
  await expect(shell.locator('[data-testid=pill-new-reply]')).toBeVisible()
  await expect(shell.locator('[data-testid=pill-jump]')).toHaveCount(0)
  await expect(dot(shell)).toBeVisible()
  const before = await scrollTop(shell)
  await shell.waitForTimeout(2000)
  const after = await scrollTop(shell)
  const noJumpWhileUnpinned = after === before
  expect(noJumpWhileUnpinned).toBe(true)
  await proofShot(app, shell, 'chat-new-reply')
  const newReplyShown = true

  await shell.locator('[data-testid=pill-new-reply]').click()
  await expect.poll(() => gap(shell)).toBeLessThanOrEqual(1)
  await expect(shell.locator('[data-testid=pill-new-reply], [data-testid=pill-jump]')).toHaveCount(
    0,
  )
  await expect(dot(shell)).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => gap(shell)).toBeLessThanOrEqual(1)

  const rs = await chatStats(shell)
  const main = await app.evaluate(() =>
    (
      globalThis as unknown as {
        __evaosTest: {
          hooks: {
            chat: { stats(p: string): { batches: number; lastSeq: number; framesIn: number } }
          }
        }
      }
    ).__evaosTest.hooks.chat.stats('pane-1'),
  )
  const hz = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().displayFrequency)
  const budgetMs = Math.max(16.7, Math.round(idle.p95 * 1.25 * 100) / 100)
  // A host busy with other work (other agents on the Mini: load average per core above
  // BUSY_LOAD_PER_CPU) or frames over 50 ms in the idle baseline cannot say anything about the
  // app's frame times, so the two frame-time checks below are skipped. The sequence checks and
  // everything functional always run.
  const hostNoisy = idleLong > 0 || hostBusy
  const passed = hostNoisy || (stream.p95 <= budgetMs && longFrames === 0)

  recordMetrics('chat', {
    messages: 5000,
    framesReplayed: main.framesIn,
    hostNoisy,
    seqGaps: rs.gaps - gapsBeforeStream,
    seqGapsAtOpen: gapsBeforeStream,
    seqContiguous: rs.lastSeq === main.batches,
    display: { hz },
    idle,
    stream: { ...stream, longFrames },
    gate: {
      rule: 'streamP95 <= max(16.7, idleP95 * 1.25) and zero frames over 50 ms',
      budgetMs,
      passed,
    },
    pinnedGapPx,
    noJumpWhileUnpinned,
    jumpPillShown,
    newReplyShown,
    profilerCommitP95Ms: profile.length > 10 ? prof.p95 : null,
    profilerCommits: profile.length,
    longAnimationFrames: { count: lafs.length, maxMs: Math.max(0, ...lafs) },
  })

  expect(rs.gaps - gapsBeforeStream).toBe(0)
  expect(rs.lastSeq).toBe(main.batches)
  if (hostNoisy) {
    const why = `${idleLong} idle frames over 50 ms, host load ${loadBefore.toFixed(2)} per core before the stream, busy: ${hostBusy}`
    console.log(`HOST NOISY: ${why}; the frame-time checks are skipped`)
    test.info().annotations.push({ type: 'host-noisy', description: why })
  } else {
    expect(longFrames).toBe(0)
    expect(stream.p95).toBeLessThanOrEqual(budgetMs)
  }
})
