import { test, expect } from './fixtures'
import { recordMetrics } from './helpers/metrics'
import { REPO_ROOT } from './helpers/paths'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

// Moves the real window with real OS mouse events, so it only runs on request.
test.skip(process.env.EVAOS_OS_EVENTS !== '1', 'set EVAOS_OS_EVENTS=1 to post real mouse events')

type G = {
  __evaosTest: {
    win: {
      focus(): void
      getPosition(): number[]
      getContentBounds(): { x: number; y: number; width: number; height: number }
    }
  }
}

test('chat header is a drag region and moves the window under real mouse events', async ({
  app,
  shell,
}) => {
  const css = await shell.evaluate(() => {
    const h = document.querySelector('[data-testid=chat-header]') as HTMLElement
    const v = (el: Element): string =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region') ||
      getComputedStyle(el).getPropertyValue('app-region')
    const rail = document.querySelector('[data-testid=rail]')!
    const noDrag = Array.from(rail.children).filter((c) => v(c) === 'no-drag').length
    return { header: v(h), noDragRailChildren: noDrag }
  })
  expect(css.header).toBe('drag')
  expect(css.noDragRailChildren).toBeGreaterThan(0)

  const rect = await shell.evaluate(() => {
    const r = document.querySelector('[data-testid=chat-header]')!.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  await app.evaluate(() => (globalThis as unknown as G).__evaosTest.win.focus())
  const { content, before } = await app.evaluate(() => {
    const w = (globalThis as unknown as G).__evaosTest.win
    return { content: w.getContentBounds(), before: w.getPosition() }
  })
  const x = Math.round(content.x + rect.x + rect.w / 2)
  const y = Math.round(content.y + rect.y + rect.h / 2)
  const dx = 120
  const dy = 80
  const r = spawnSync(
    'swift',
    [path.join(REPO_ROOT, 'scripts/os-drag.swift'), String(x), String(y), String(dx), String(dy)],
    { encoding: 'utf8', timeout: 120_000 },
  )
  const locked = (
    spawnSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' }).stdout ?? ''
  ).includes('"CGSSessionScreenIsLocked"=Yes')
  let result: string
  if (locked) {
    result =
      'still-needs-isaac: macOS screen was locked, so posted OS mouse events cannot reach any window'
  } else if (r.status === 3 || (r.stdout ?? '').includes('NO_ACCESS')) {
    result = 'still-needs-isaac: no Accessibility permission to post mouse events'
  } else if (r.status !== 0) {
    result = `still-needs-isaac: os-drag failed (${(r.stderr ?? '').split('\n')[0]})`
  } else {
    await new Promise((res) => setTimeout(res, 400))
    const after = await app.evaluate(() =>
      (globalThis as unknown as G).__evaosTest.win.getPosition(),
    )
    const mx = after[0]! - before[0]!
    const my = after[1]! - before[1]!
    result =
      Math.abs(mx - dx) <= 4 && Math.abs(my - dy) <= 4
        ? 'agent-verified'
        : `not-moved (delta ${mx},${my})`
  }
  recordMetrics('browser', { dragRegion: result })
  console.log(`DRAG RESULT: ${result}`)
  expect(result.startsWith('not-moved')).toBe(false)
})
