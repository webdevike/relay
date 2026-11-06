import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

// The sidebar's icon row shares the window footer strip with <footer>. Real pointer input must
// reach the icons: nothing may sit on top of them, and the footer's drag region must not cover
// them (Chromium resolves overlapping app-regions last-in-tree-order wins, and the footer is
// later in the tree than the sidebar, so its drag region eats clicks and hovers).
type Hooks = { __evaosTest: { hooks: { update: { offer(u: object): void } } } }

const ICONS = ['nav-setting', 'nav-usage', 'update-button'] as const

test.use({ startOnChat: false, toolPanes: false })

/** Effective app-region at a point: the last element (or ::before) in tree order that sets one. */
async function regionAt(shell: Page, x: number, y: number): Promise<string> {
  return shell.evaluate(
    ([px, py]) => {
      let region = 'none'
      const inside = (r: { left: number; right: number; top: number; bottom: number }): boolean =>
        px! >= r.left && px! < r.right && py! >= r.top && py! < r.bottom
      const val = (cs: CSSStyleDeclaration): string =>
        cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') || 'none'
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        const own = val(getComputedStyle(el))
        if ((own === 'drag' || own === 'no-drag') && inside(r)) region = own
        const before = getComputedStyle(el, '::before')
        const bv = val(before)
        if ((bv === 'drag' || bv === 'no-drag') && before.content !== 'none') {
          const w = parseFloat(before.width)
          if (inside({ left: r.left, right: r.left + w, top: r.top, bottom: r.bottom })) region = bv
        }
      }
      return region
    },
    [x, y],
  )
}

test('footer icons receive real clicks and hovers: nothing on top, not in a drag region', async ({
  app,
  shell,
}) => {
  await app.evaluate(() => {
    ;(globalThis as unknown as Hooks).__evaosTest.hooks.update.offer({
      summary: 'Faster chat list',
      build: 'e2e1234abcd',
    })
  })
  await expect(shell.locator('[data-testid=update-button]')).toHaveAttribute(
    'aria-label',
    'Update and restart',
  )
  for (const id of ICONS) {
    const box = (await shell.locator(`[data-testid=${id}]`).boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    const hit = await shell.evaluate(
      ([px, py]) => {
        const el = document.elementFromPoint(px!, py!)
        return el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null
      },
      [x, y],
    )
    expect(hit, `${id}: element at its centre`).toBe(id)
    expect(await regionAt(shell, x, y), `${id}: app-region at its centre`).toBe('no-drag')
  }

  // Real mouse at the centre: hover the update icon shows the card.
  const upd = (await shell.locator('[data-testid=update-button]').boundingBox())!
  await shell.mouse.move(upd.x + upd.width / 2, upd.y + upd.height / 2)
  await expect(shell.locator('[data-testid=update-popover]')).toBeVisible()
  await shell.mouse.move(700, 300)
  await expect(shell.locator('[data-testid=update-popover]')).toHaveCount(0)
})

async function clickCentre(shell: Page, id: string): Promise<void> {
  const b = (await shell.locator(`[data-testid=${id}]`).boundingBox())!
  await shell.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

test('a real click on the gear opens Settings', async ({ shell }) => {
  await clickCentre(shell, 'nav-setting')
  await expect(shell.locator('[data-testid=sidebar]')).toHaveAttribute(
    'data-sidebar-level',
    'settings',
  )
})

test('a real click on the chart opens Settings > Usage', async ({ shell }) => {
  await clickCentre(shell, 'nav-usage')
  await expect(shell.locator('[data-testid=settings-item-usage]')).toHaveAttribute(
    'data-active',
    'true',
  )
})
