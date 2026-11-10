// A dashboard's Mantine tiles: a stand-in Relay host sends a board with a ```mantine-widget tile
// sized by its content (three cards, each a Mantine AspectRatio 4:3 holding an Image), one with a
// fixed height whose JSX fills it (Image h="100%" and useViewportSize() reading the tile's box), and
// a plain spec tile. Both Mantine tiles run in the chat's sandboxed relay-widget: page; the shots go
// to proof/board-mantine/ in light and dark.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/boards-mantine.spec.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { FIXTURES_DIR, REPO_ROOT } from './helpers/paths'

const MEDIA = path.join(FIXTURES_DIR, 'agent-widgets', 'media')
const OUT = path.join(REPO_ROOT, 'proof', 'board-mantine')
const HERO_HEIGHT = 300

const dataUri = (name: string): string =>
  `data:image/jpeg;base64,${fs.readFileSync(path.join(MEDIA, name)).toString('base64')}`

function board() {
  const deals = [
    { name: 'Desk lamp', price: '$24', was: '$39', img: dataUri('gallery-1.jpg') },
    { name: 'Headphones', price: '$89', was: '$149', img: dataUri('gallery-2.jpg') },
    { name: 'Coffee grinder', price: '$31', was: '$45', img: dataUri('gallery-3.jpg') },
  ]
  const cards = `const deals = ${JSON.stringify(deals)};
return (
  <SimpleGrid cols={3} spacing="sm">
    {deals.map((d) => (
      <Card key={d.name} withBorder radius="md" padding="sm">
        <Card.Section>
          <AspectRatio ratio={4 / 3}>
            <Image src={d.img} alt={d.name} fit="cover" />
          </AspectRatio>
        </Card.Section>
        <Text fw={600} mt="xs">{d.name}</Text>
        <Group gap="xs">
          <Text c="green" fw={700}>{d.price}</Text>
          <Text td="line-through" c="dimmed" size="sm">{d.was}</Text>
        </Group>
      </Card>
    ))}
  </SimpleGrid>
);`
  const hero = `const { width, height } = useViewportSize();
return (
  <Card h="100%" radius="md" padding={0} withBorder pos="relative">
    <Image src=${JSON.stringify(dataUri('image.jpg'))} alt="Deal of the day" h="100%" fit="cover" />
    <Badge pos="absolute" top={8} left={8} data-testid="tile-size">{width}x{height}</Badge>
  </Card>
);`
  return {
    slug: 'deals',
    title: "Penny's deals",
    workspace: 'Personal',
    widgets: [
      {
        id: 'cards',
        span: 8,
        spec: { widget: 'text', text: 'Needs a newer Relay.' },
        mantine: cards,
      },
      {
        id: 'hero',
        span: 4,
        spec: { widget: 'text', text: 'Needs a newer Relay.' },
        mantine: hero,
        height: HERO_HEIGHT,
      },
      { id: 'count', span: 12, spec: { widget: 'stat', label: 'Deals today', value: '3' } },
    ],
    updatedAt: new Date().toISOString(),
  }
}

let host: FakeRelayHost
let root: string

const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-board-mantine-'))
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

async function scheme(shell: Page, s: 'light' | 'dark'): Promise<void> {
  await pickScheme(shell, s)
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
}

test('Mantine board tiles run sandboxed at the tile size: AspectRatio cards and a filled fixed-height tile', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await sizeWindow(app)
  type Shell = { __evaosShell: { openPlace(p: string): void } }
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('board:deals'))
  const page = shell.getByTestId('board-deals')
  await expect(page.getByTestId('board-grid')).toBeVisible()
  await expect(page.getByTestId('board-tile-count')).toContainText('Deals today')

  const cardsTile = page.getByTestId('board-tile-cards')
  const heroTile = page.getByTestId('board-tile-hero')
  await expect(cardsTile).toHaveAttribute('data-mantine', 'true')
  const cardsEl = cardsTile.locator('iframe')
  const heroEl = heroTile.locator('iframe')
  // The chat's sandbox: scripts only, from the relay-widget: scheme; only the fixed tile fills.
  await expect(cardsEl).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(heroEl).toHaveAttribute('sandbox', 'allow-scripts')
  expect(await cardsEl.getAttribute('src')).toMatch(/^relay-widget:\/\/frame\/mantine\?/)
  expect(await cardsEl.getAttribute('src')).not.toContain('fill=1')
  expect(await heroEl.getAttribute('src')).toContain('fill=1')

  // Content-sized tile: three cards whose images are 4:3 at the tile's width, all loaded.
  const cards = cardsEl.contentFrame()
  await expect(cards.locator('.mantine-AspectRatio-root')).toHaveCount(3, { timeout: 20_000 })
  const images = cards.locator('img.mantine-Image-root')
  await expect(images).toHaveCount(3)
  for (const img of await images.all()) {
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0)
    const box = (await img.boundingBox())!
    expect(Math.abs(box.width / box.height - 4 / 3)).toBeLessThan(0.02)
  }
  const tileWidth = (await cardsTile.boundingBox())!.width
  expect(Math.abs((await cardsEl.boundingBox())!.width - tileWidth)).toBeLessThan(1)
  // The frame grew to its content: no placeholder, no inner scroll, no scrollbar taking width.
  await expect(cardsTile.getByTestId('widget-page-pending')).toHaveCount(0)
  expect(await cards.locator('html').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(
    true,
  )
  expect(await cards.locator('html').evaluate((el) => window.innerWidth - el.clientWidth)).toBe(0)

  // Fixed tile: the frame is the tile's height, the image fills it and the JSX reads its box.
  const hero = heroEl.contentFrame()
  const heroBox = (await heroEl.boundingBox())!
  expect(heroBox.height).toBe(HERO_HEIGHT)
  await expect(hero.getByTestId('tile-size')).toHaveText(
    `${Math.round(heroBox.width)}x${HERO_HEIGHT}`,
    { timeout: 20_000 },
  )
  const heroImg = hero.locator('img.mantine-Image-root')
  await expect
    .poll(() => heroImg.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0)
  const imgBox = (await heroImg.boundingBox())!
  expect(imgBox.height).toBeGreaterThan(HERO_HEIGHT - 4)

  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })
  for (const s of ['light', 'dark'] as const) {
    await scheme(shell, s)
    await expect(cards.locator('html')).toHaveAttribute('data-mantine-color-scheme', s)
    await expect(hero.locator('html')).toHaveAttribute('data-mantine-color-scheme', s)
    await expect(cards.locator('.mantine-AspectRatio-root')).toHaveCount(3)
    await shell.waitForTimeout(400)
    await page.screenshot({ path: path.join(OUT, `board-mantine-${s}.png`) })
  }
})
