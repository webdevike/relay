// A tabbed dashboard: a stand-in Relay host sends "Penny's lists" with two tabs. Deals holds a stat
// tile and a Mantine tile (a Card with an https Image and a caption); Wife's list holds a rows tile.
// The page shows one tab's tiles at a time. Shots go to proof/board-tabs/ with each tab picked. The
// https image needs the Mantine frame's CSP to allow `img-src https:` (packages/widget-runtime).
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/boards-tabs.spec.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { REPO_ROOT } from './helpers/paths'

const OUT = path.join(REPO_ROOT, 'proof', 'board-tabs')
const IMAGE =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/330px-PNG_transparency_demonstration_1.png'

function board() {
  const deal = `return (
  <Card withBorder radius="md" padding="sm" w={320}>
    <Card.Section>
      <Image src=${JSON.stringify(IMAGE)} alt="Dice" h={200} fit="contain" />
    </Card.Section>
    <Text fw={600} mt="xs">Dice, two for one</Text>
    <Text size="sm" c="dimmed">Picked up at the market, ends Sunday.</Text>
  </Card>
);`
  const fallback = { widget: 'text', text: 'Needs a newer Relay.' }
  return {
    slug: 'penny-lists',
    title: "Penny's lists",
    workspace: 'Personal',
    widgets: [],
    tabs: [
      {
        id: 'deals',
        title: 'Deals',
        widgets: [
          {
            id: 'deal-count',
            span: 12,
            spec: { widget: 'stat', label: 'Deals today', value: '3' },
          },
          { id: 'deal-card', span: 12, spec: fallback, mantine: deal },
        ],
      },
      {
        id: 'wife',
        title: "Wife's list",
        widgets: [
          {
            id: 'wife-rows',
            span: 12,
            spec: {
              widget: 'rows',
              rows: [
                { label: 'Tulips', value: 'Saturday' },
                { label: 'Birthday card', value: 'Friday' },
                { label: 'Oat milk', value: 'Today' },
              ],
            },
          },
        ],
      },
    ],
    updatedAt: new Date().toISOString(),
  }
}

let host: FakeRelayHost
let root: string

const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-board-tabs-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.setBoards([board()])
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

async function sizeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    (_e, [w, h]) => {
      const hooks = globalThis as unknown as {
        __evaosTest: { win: { setContentSize(w: number, h: number): void } }
      }
      hooks.__evaosTest.win.setContentSize(w, h)
    },
    [1400, 900] as const,
  )
}

test('a tabbed board shows one tab of tiles at a time', async ({ app, shell }) => {
  test.setTimeout(120_000)
  await sizeWindow(app)
  type Shell = { __evaosShell: { openPlace(p: string): void } }
  await shell.evaluate(() =>
    (window as unknown as Shell).__evaosShell.openPlace('board:penny-lists'),
  )
  const page = shell.getByTestId('board-penny-lists')
  await expect(page.getByTestId('board-tabs')).toBeVisible()
  await expect(page.getByTestId('board-tab-deals')).toHaveAttribute('aria-selected', 'true')
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  // Deals: the stat and the Mantine card; nothing of the other tab.
  await expect(page.getByTestId('board-tile-deal-count')).toContainText('Deals today')
  const card = page.getByTestId('board-tile-deal-card')
  await expect(card).toHaveAttribute('data-mantine', 'true')
  const frame = card.locator('iframe').contentFrame()
  await expect(frame.getByText('Dice, two for one')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('board-tile-wife-rows')).toHaveCount(0)
  // The https image loads inside the sandboxed frame (needs the frame CSP to allow https images).
  await expect
    .poll(() =>
      frame.locator('img.mantine-Image-root').evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0)
  await shell.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'desktop-tab-deals.png') })

  // Wife's list: its rows, and the Deals tiles are gone.
  await page.getByTestId('board-tab-wife').click()
  await expect(page.getByTestId('board-tab-wife')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('board-tile-wife-rows')).toContainText('Birthday card')
  await expect(page.getByTestId('board-tile-deal-count')).toHaveCount(0)
  await expect(page.getByTestId('board-tile-deal-card')).toHaveCount(0)
  await shell.waitForTimeout(400)
  await page.screenshot({ path: path.join(OUT, 'desktop-tab-wife.png') })
})
