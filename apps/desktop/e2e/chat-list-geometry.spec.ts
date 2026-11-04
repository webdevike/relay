// Chat list geometry: painted surfaces in the chat sidebar never merge. For light and dark at a
// 272px and a 360px sidebar it hovers a folder header right above the active chat and measures
// the boxes that carry the backgrounds (getBoundingClientRect on the test-id elements):
//   - the hovered header and the active row are at least GAP_PX apart, as are any two adjacent
//     row or header surfaces;
//   - content (text, icons) sits at least INSET_X_PX / INSET_Y_PX inside each surface;
//   - every row and header is at least MIN_HEIGHT_PX tall;
//   - no two interactive surfaces overlap.
// With CHAT_LIST_PROOF=before|after it also writes the hovered sidebar to
// proof/chat-list-mantine/<CHAT_LIST_PROOF>/.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/chat-list-geometry.spec.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { REPO_ROOT } from './helpers/paths'
import { pickScheme } from './helpers/appearance'

/** Minimum distance between two painted surfaces (the design's row gap is spacing-xs / 2). */
const GAP_PX = 4
const INSET_X_PX = 8
const INSET_Y_PX = 4
const MIN_HEIGHT_PX = 32

type Scheme = 'light' | 'dark'
const SCHEMES: Scheme[] = ['light', 'dark']
const WIDTHS = [272, 360]
/** Every clickable surface of the list, by test id. */
const SURFACES =
  '[data-testid^="chat-row-"], [data-testid^="chat-group-"], [data-testid^="chat-show-more-"], [data-testid="chat-snoozed-toggle"], [data-testid="chat-settled-toggle"]'

let fx: ChatFixture
const test = base.extend<{ sidebarWidth: number }>({
  sidebarWidth: [272, { option: true }],
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    await use(fx.launchEnv)
    fx.cleanup()
  },
  configDir: async ({ configDir, sidebarWidth }, use) => {
    fs.writeFileSync(
      path.join(configDir, 'layout.json'),
      JSON.stringify({ sidebar_width: sidebarWidth }),
    )
    await use(configDir)
  },
})
test.use({ reducedMotion: 'reduce' })

interface Box {
  id: string
  top: number
  bottom: number
  left: number
  right: number
  height: number
  bg: string
  /** The visible content box: text and icons, clipped by overflow ancestors. */
  content: { top: number; bottom: number; left: number; right: number } | null
}

async function scheme(shell: Page, s: Scheme): Promise<void> {
  await pickScheme(shell, s)
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
}

/** Measures every visible surface inside the chat list, top to bottom. */
function measure(shell: Page): Promise<Box[]> {
  return shell.evaluate((selector) => {
    const tree = document.querySelector('[data-testid=chat-tree]')!
    const clipOf = (node: Node): DOMRect | null => {
      let clip: DOMRect | null = null
      for (let el = node.parentElement; el && el !== tree; el = el.parentElement) {
        const cs = getComputedStyle(el)
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
          const r = el.getBoundingClientRect()
          clip = clip
            ? new DOMRect(
                Math.max(clip.left, r.left),
                Math.max(clip.top, r.top),
                Math.min(clip.right, r.right) - Math.max(clip.left, r.left),
                Math.min(clip.bottom, r.bottom) - Math.max(clip.top, r.top),
              )
            : r
        }
      }
      return clip
    }
    const visible = (el: Element): boolean => {
      const cs = getComputedStyle(el)
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0
    }
    const contentOf = (root: Element): Box['content'] => {
      let top = Infinity
      let bottom = -Infinity
      let left = Infinity
      let right = -Infinity
      const add = (r: DOMRect, node: Node): void => {
        if (r.width === 0 || r.height === 0) return
        const c = clipOf(node)
        const l = c ? Math.max(r.left, c.left) : r.left
        const rt = c ? Math.min(r.right, c.right) : r.right
        const t = c ? Math.max(r.top, c.top) : r.top
        const b = c ? Math.min(r.bottom, c.bottom) : r.bottom
        if (rt <= l || b <= t) return
        top = Math.min(top, t)
        bottom = Math.max(bottom, b)
        left = Math.min(left, l)
        right = Math.max(right, rt)
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim() || !n.parentElement || !visible(n.parentElement)) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        for (const r of range.getClientRects()) add(r, n)
      }
      for (const el of root.querySelectorAll('svg, img')) {
        if (visible(el)) add(el.getBoundingClientRect(), el)
      }
      return top === Infinity ? null : { top, bottom, left, right }
    }
    return [...tree.querySelectorAll(selector)]
      .filter((el) => el.getClientRects().length > 0 && visible(el))
      .map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-testid')!,
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          height: r.height,
          bg: getComputedStyle(el).backgroundColor,
          content: contentOf(el),
        }
      })
      .sort((a, b) => a.top - b.top || a.left - b.left)
  }, SURFACES)
}

const transparent = (bg: string): boolean =>
  bg === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(bg) || /\/\s*0\)$/.test(bg)
const vGap = (a: Box, b: Box): number => Math.max(b.top - a.bottom, a.top - b.bottom)
const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5
const px = (n: number): string => `${Math.round(n * 100) / 100}px`

for (const s of SCHEMES) {
  for (const width of WIDTHS) {
    test.describe(`${s}, ${width}px sidebar`, () => {
      test.use({ sidebarWidth: width })

      test(`hovered header, active row and neighbors keep apart (${s}, ${width}px)`, async ({
        shell,
      }) => {
        await scheme(shell, s)
        await shell.getByTestId('nav-chat').click()
        await shell.waitForSelector('[data-testid=chat-tree]')

        // The active row is the first chat of the eCard folder, right under its header.
        const section = shell.getByTestId('chat-section-eCard')
        const header = shell.getByTestId('chat-group-eCard')
        const first = section.locator('[data-testid^="chat-row-"]').first()
        const activeId = (await first.getAttribute('data-testid'))!
        await first.click()
        await expect(shell.getByTestId(activeId)).toHaveAttribute('data-active', 'true')
        await header.hover()
        // Hover fades in over --eva-dur-fast: wait until the painted color stops changing.
        let last = ''
        await expect
          .poll(
            async () => {
              const bg = await header.evaluate((el) => getComputedStyle(el).backgroundColor)
              const settled = bg === last
              last = bg
              return settled
            },
            { intervals: [50, 100, 100, 200] },
          )
          .toBe(true)

        const proof = process.env['CHAT_LIST_PROOF']
        if (proof) {
          const sidebar = shell.locator('[data-testid=sidebar]').first()
          const out = path.join(REPO_ROOT, 'proof', 'chat-list-mantine', proof)
          fs.mkdirSync(out, { recursive: true })
          await sidebar.screenshot({ path: path.join(out, `hover-folder-${s}-${width}.png`) })
        }

        const boxes = await measure(shell)
        const hovered = boxes.find((b) => b.id === 'chat-group-eCard')!
        const active = boxes.find((b) => b.id === activeId)!
        const problems: string[] = []

        // The measured elements are the painted ones.
        if (transparent(hovered.bg)) problems.push(`hovered header paints nothing (${hovered.bg})`)
        if (transparent(active.bg)) problems.push(`active row paints nothing (${active.bg})`)

        const d = vGap(hovered, active)
        if (d < GAP_PX) {
          problems.push(`hovered header to active row: ${px(d)} apart, want >= ${GAP_PX}px`)
        }
        for (let i = 1; i < boxes.length; i++) {
          const a = boxes[i - 1]!
          const b = boxes[i]!
          const g = vGap(a, b)
          if (g < GAP_PX) problems.push(`${a.id} to ${b.id}: ${px(g)} apart, want >= ${GAP_PX}px`)
        }
        for (const b of boxes) {
          if (b.id.startsWith('chat-row-') || b.id.startsWith('chat-group-')) {
            if (b.height < MIN_HEIGHT_PX) {
              problems.push(`${b.id}: ${px(b.height)} tall, want >= ${MIN_HEIGHT_PX}px`)
            }
            const c = b.content
            if (c) {
              const insets = {
                left: c.left - b.left,
                right: b.right - c.right,
                top: c.top - b.top,
                bottom: b.bottom - c.bottom,
              }
              for (const [side, v] of Object.entries(insets)) {
                const want = side === 'left' || side === 'right' ? INSET_X_PX : INSET_Y_PX
                if (v < want - 0.5)
                  problems.push(`${b.id}: ${side} inset ${px(v)}, want >= ${want}px`)
              }
            }
          }
        }
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            if (overlaps(boxes[i]!, boxes[j]!))
              problems.push(`${boxes[i]!.id} overlaps ${boxes[j]!.id}`)
          }
        }
        // The scrollbar keeps its own lane: no row or header reaches within GAP_PX of it.
        const bar = await shell.evaluate(() => {
          const el = document
            .querySelector('[data-testid=chat-tree]')
            ?.closest('.mantine-ScrollArea-root')
            ?.querySelector('.mantine-ScrollArea-scrollbar[data-orientation=vertical]')
          if (!el) return null
          const r = el.getBoundingClientRect()
          return r.width > 0 ? { left: r.left, top: r.top, bottom: r.bottom } : null
        })
        expect(bar, 'the fixture list overflows, so a vertical scrollbar exists').not.toBeNull()
        for (const b of boxes) {
          const sideBySide = b.bottom > bar!.top && b.top < bar!.bottom
          if (sideBySide && bar!.left - b.right < GAP_PX)
            problems.push(
              `${b.id}: ${px(bar!.left - b.right)} from the scrollbar, want >= ${GAP_PX}px`,
            )
        }
        expect(boxes.length, 'surfaces measured').toBeGreaterThan(5)
        expect(problems, `geometry (${s}, ${width}px)`).toEqual([])
      })
    })
  }
}
