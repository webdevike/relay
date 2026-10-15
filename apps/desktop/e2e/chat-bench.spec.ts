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

const BENCH = '2026-10-02T09-00-00-000Z_bench5000'

test.use({ launchEnv: { FAKE_OMP_RECORDING: 'long-turn', FAKE_OMP_DELAY_MS: '16' } })

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
const dot = (shell: Page) =>
  shell.locator('[data-testid=chat-header] [aria-label="Eva is replying"]')

test('chat benchmark: 5,000 messages, pinned follow, pills, frame-time vs idle baseline', async ({
  shell,
  app,
}) => {
  test.setTimeout(120_000)
  await shell.locator(`[data-testid=session-${BENCH}]`).click()
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('LAST-MESSAGE-MARKER')
  await expect.poll(() => gap(shell)).toBeLessThan(24)
  await shell.evaluate(() => {
    ;(window as unknown as { __evaosChatProfile: number[] }).__evaosChatProfile = []
  })

  // Idle baseline, same run, same window.
  await startFrameSampler(shell)
  await shell.waitForTimeout(3000)
  const idle = percentiles(await stopFrameSampler(shell))

  // Streaming while pinned.
  const box = shell.locator('[data-testid=composer-input]')
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
      await startFrameSampler(shell)
    }
    await shell.waitForTimeout(500)
  }
  frames = frames.concat(await stopFrameSampler(shell))
  const stream = percentiles(frames)
  const longFrames = frames.slice(10).filter((d) => d > 50).length
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

  const rs = await shell.evaluate(
    () =>
      (
        window as unknown as {
          __evaosChatStats: Record<string, { batches: number; gaps: number; lastSeq: number }>
        }
      ).__evaosChatStats['pane-1']!,
  )
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
  const passed = stream.p95 <= budgetMs && longFrames === 0

  recordMetrics('chat', {
    messages: 5000,
    framesReplayed: main.framesIn,
    batches: main.batches,
    seqGaps: rs.gaps,
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

  expect(rs.gaps).toBe(0)
  expect(rs.lastSeq).toBe(main.batches)
  expect(longFrames).toBe(0)
  expect(stream.p95).toBeLessThanOrEqual(budgetMs)
})
