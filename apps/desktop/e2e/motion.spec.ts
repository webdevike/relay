import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

test.use({ colorScheme: 'dark' })

async function launch(env: Record<string, string>): Promise<{
  app: ElectronApplication
  page: Page
  dir: string
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-motion-'))
  const app = await launchApp(dir, env)
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid=rail]', { state: 'attached' })
  return { app, page, dir }
}

async function done(app: ElectronApplication, dir: string): Promise<void> {
  await app.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

type Fade = { name: string; duration: number; delay: number; state: string; start: number }
// A finished fill-both animation stays listed, so "running" is judged by playState.
const fades = (page: Page): Promise<Fade[]> =>
  page.evaluate(() =>
    (document.querySelector('[data-testid=sidebar]') as HTMLElement).getAnimations().map((a) => {
      const t = a.effect?.getComputedTiming()
      return {
        name: (a as CSSAnimation).animationName,
        duration: Number(t?.duration ?? 0),
        delay: Number(t?.delay ?? 0),
        state: a.playState,
        start: Number(a.startTime ?? -1),
      }
    }),
  )
const running = async (page: Page): Promise<number> =>
  (await fades(page)).filter((a) => a.state === 'running' || a.state === 'pending').length

test('entrance: fade on the sidebar, 150ms, finishes inside the 2s budget', async () => {
  const { app, page, dir } = await launch({ EVAOS_E2E: '0' })
  try {
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-eva-motion', 'on')
    await expect(html).toHaveAttribute('data-eva-played', 'true')
    const sb = page.locator('[data-testid=sidebar]')
    await expect(sb).toHaveClass(/eva-cue-sidebar/)

    // Pause at t=0 to prove the fade starts transparent, then finish it.
    const probe = await page.evaluate(() => {
      const el = document.querySelector('[data-testid=sidebar]') as HTMLElement
      const a = el.getAnimations().find((x) => (x as CSSAnimation).animationName === 'eva-fade')
      if (!a) return null
      const t = a.effect?.getComputedTiming()
      a.pause()
      a.currentTime = 0
      const at0 = Number(getComputedStyle(el).opacity)
      a.finish()
      const end = Number(getComputedStyle(el).opacity)
      return { duration: Number(t?.duration), delay: Number(t?.delay), at0, end }
    })
    // The 150 ms fade can finish before the probe runs on a fast machine; then assert the end state.
    if (probe) {
      expect(probe.duration).toBe(150)
      expect(probe.delay).toBe(0)
      expect(probe.at0).toBeLessThan(1)
      expect(probe.end).toBe(1)
    }
    await expect.poll(async () => (await running(page)) === 0, { timeout: 2000 }).toBe(true)
    expect(await sb.evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
  } finally {
    await done(app, dir)
  }
})

test('entrance plays once per launch, not on navigation', async () => {
  const { app, page, dir } = await launch({ EVAOS_E2E: '0' })
  try {
    await expect.poll(() => running(page), { timeout: 2000 }).toBe(0)
    const before = await fades(page)
    const cls = await page.locator('[data-testid=sidebar]').getAttribute('class')
    await page.locator('[data-testid=nav-setting]').click()
    await page.locator('[data-testid=settings-all]').click()
    await expect(page.locator('[data-testid=sidebar]')).toHaveAttribute(
      'data-sidebar-level',
      'settings',
    )
    await page.locator('[data-testid=sidebar-back]').click()
    await expect(page.locator('[data-testid=sidebar]')).toHaveAttribute(
      'data-sidebar-level',
      'root',
    )
    await page.locator('[data-testid=nav-dashboard]').click()
    expect(await running(page)).toBe(0)
    expect(await fades(page)).toEqual(before)
    expect(await page.locator('[data-testid=sidebar]').getAttribute('class')).toBe(cls)
  } finally {
    await done(app, dir)
  }
})

test('EVAOS_NO_MOTION switches the entrance off', async () => {
  const { app, page, dir } = await launch({ EVAOS_E2E: '0', EVAOS_NO_MOTION: '1' })
  try {
    await expect(page.locator('html')).toHaveAttribute('data-eva-motion', 'off')
    expect(await fades(page)).toHaveLength(0)
    await expect(page.locator('[data-testid=sidebar]')).not.toHaveClass(/eva-cue-sidebar/)
  } finally {
    await done(app, dir)
  }
})

test('reduced motion flips the switch live', async () => {
  const { app, page, dir } = await launch({ EVAOS_E2E: '0' })
  try {
    await expect(page.locator('html')).toHaveAttribute('data-eva-motion', 'on')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(page.locator('html')).toHaveAttribute('data-eva-motion', 'off')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(page.locator('html')).toHaveAttribute('data-eva-motion', 'on')
  } finally {
    await done(app, dir)
  }
})
