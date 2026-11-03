// Expand contract: every visible, enabled element that says aria-expanded must keep its word. On
// each main page this clicks every one, and asserts that aria-expanded flipped and that the region
// it controls (aria-controls, else its next sibling) changed visibility; a second click restores
// both. The chat folder fixture has a chat that is still running, as the Relay feed reports idle
// sessions, so a folder that refuses to collapse fails here.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/expand-contract.spec.ts
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { makeEvaFixture, type EvaFixture } from './helpers/eva-fixture'

type ShellHooks = {
  __evaosShell: { openPlace(page: string, newTab?: boolean, extra?: object): void }
}

let chatFx: ChatFixture
const test = base.extend<{ evaFx: EvaFixture }>({
  evaFx: async ({}, use) => {
    const fx = makeEvaFixture()
    await use(fx)
    fx.cleanup()
  },
  launchEnv: async ({ evaFx }, use) => {
    chatFx = makeChatFixture()
    // A chat written a moment ago counts as running, as Relay-listed sessions do.
    chatFx.touch('p4-ecard', 0)
    await use({ ...evaFx.env, ...chatFx.launchEnv })
    chatFx.cleanup()
  },
})
test.use({ reducedMotion: 'reduce' })

const MARK = 'data-xc'
const POLL = { timeout: 2000 }

interface Target {
  label: string
  /** A selector that finds the element again after a re-render: its test id when unique. */
  key: string
}

/** Finds every visible, enabled aria-expanded element inside `scope`. */
function targets(shell: Page, scope: string): Promise<Target[]> {
  return shell.evaluate(
    ([scopeSel, mark]) => {
      for (const el of document.querySelectorAll(`[${mark}]`)) el.removeAttribute(mark)
      const root = document.querySelector(scopeSel)
      if (!root) return []
      const out: Target[] = []
      for (const el of root.querySelectorAll<HTMLElement>('[aria-expanded]')) {
        if (el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled)
          continue
        const cs = getComputedStyle(el)
        if (el.getClientRects().length === 0 || cs.visibility === 'hidden') continue
        const testId = el.getAttribute('data-testid')
        let key = `[${mark}="${out.length}"]`
        if (testId && document.querySelectorAll(`[data-testid="${testId}"]`).length === 1) {
          key = `[data-testid="${testId}"]`
        } else {
          el.setAttribute(mark, String(out.length))
        }
        const name = testId ?? el.getAttribute('aria-label') ?? (el.textContent ?? '').trim()
        out.push({ label: `${el.tagName.toLowerCase()} "${name.slice(0, 40)}"`, key })
      }
      return out
    },
    [scope, MARK] as const,
  )
}

interface State {
  expanded: string | null
  controls: string | null
  regionVisible: boolean
}

/** The element's aria-expanded and whether its region (aria-controls, else next sibling) shows. */
function state(shell: Page, key: string, controls: string | null): Promise<State | null> {
  return shell.evaluate(
    ([sel, known]) => {
      const el = document.querySelector<HTMLElement>(sel)
      if (!el) return null
      const id = el.getAttribute('aria-controls') ?? known
      const region = id ? document.getElementById(id) : el.nextElementSibling
      const visible = (r: Element | null): boolean => {
        if (!r) return false
        const cs = getComputedStyle(r)
        const box = r.getBoundingClientRect()
        return (
          cs.display !== 'none' &&
          cs.visibility !== 'hidden' &&
          Number(cs.opacity) > 0 &&
          box.height > 0 &&
          box.width > 0
        )
      }
      return {
        expanded: el.getAttribute('aria-expanded'),
        controls: id,
        regionVisible: visible(region),
      }
    },
    [key, controls] as const,
  )
}

/**
 * Clicks every target twice; returns one line per broken contract. `requireControls` also
 * demands aria-controls (the chat list's own folders), not just a next-sibling region.
 */
async function exercise(shell: Page, scope: string, requireControls = false): Promise<string[]> {
  const found = await targets(shell, scope)
  expect(found.length, `aria-expanded elements in ${scope}`).toBeGreaterThan(0)
  const problems: string[] = []
  for (const { label, key } of found) {
    const el = shell.locator(key)
    const before = await state(shell, key, null)
    if (!before) {
      problems.push(`${label}: gone before its turn (an earlier click re-rendered it away)`)
      continue
    }
    await el.click()
    let after: State = before
    // A popup target names its region only once open: before the click that region was absent.
    const beforeVisible = (a: State): boolean =>
      before.controls === null && a.controls !== null ? false : before.regionVisible
    const flipped = await expect
      .poll(async () => {
        after = (await state(shell, key, before.controls)) ?? before
        return after.expanded !== before.expanded && after.regionVisible !== beforeVisible(after)
      }, POLL)
      .toBe(true)
      .then(() => true)
      .catch(() => false)
    if (!flipped) {
      if (after.expanded === before.expanded) {
        problems.push(`${label}: aria-expanded stayed ${before.expanded} after a click`)
      } else {
        problems.push(
          `${label}: aria-expanded ${before.expanded} -> ${after.expanded} but its region (${
            after.controls ? `#${after.controls}` : 'next sibling'
          }) stayed ${after.regionVisible ? 'visible' : 'hidden'}`,
        )
      }
    }
    if (requireControls && !after.controls) problems.push(`${label}: no aria-controls`)
    if (after.expanded === before.expanded) continue
    await el.click()
    const restored = await expect
      .poll(async () => (await state(shell, key, after.controls))?.expanded, POLL)
      .toBe(before.expanded)
      .then(() => true)
      .catch(() => false)
    if (!restored) problems.push(`${label}: a second click did not restore aria-expanded`)
  }
  return problems
}

const open = (shell: Page, page: string, extra?: object): Promise<void> =>
  shell.evaluate(
    ([p, x]) => (window as unknown as ShellHooks).__evaosShell.openPlace(p, false, x),
    [page, extra] as const,
  )

test('chat sidebar: folder headers and folds expand and collapse', async ({ shell }) => {
  await shell.getByTestId('nav-chat').click()
  await shell.waitForSelector('[data-testid=chat-tree]')
  await expect(shell.getByTestId('chat-row-p4-ecard')).toBeVisible()
  expect(await exercise(shell, '[data-testid=chat-tree]', true)).toEqual([])
})

test('settings theme: every category opens and closes', async ({ shell }) => {
  await open(shell, 'settings', { settingsSection: 'Theme' })
  await expect(shell.getByTestId('settings-theme')).toBeVisible()
  expect(await exercise(shell, '[data-testid=settings-theme]')).toEqual([])
})

for (const [page, id] of [
  ['jobs', 'page-jobs'],
  ['meetings', 'page-meetings'],
  ['dashboard', 'page-dashboard'],
] as const) {
  test(`${page}: every expandable opens and closes`, async ({ shell }) => {
    await open(shell, page)
    await expect(shell.getByTestId(id)).toBeVisible()
    const found = await targets(shell, `[data-testid=${id}]`)
    test.skip(found.length === 0, `${page} shows no aria-expanded element with this fixture`)
    expect(await exercise(shell, `[data-testid=${id}]`)).toEqual([])
  })
}
