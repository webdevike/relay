import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test, expect } from './fixtures'
import { REPO_ROOT } from './helpers/paths'

test.use({ startOnChat: false, colorScheme: 'dark' })

const sel = (id: string): string => `[data-testid=${id}]`
const PROOF = path.join(REPO_ROOT, 'proof', 'canvas')
const status = (shell: Page) => shell.locator(sel('canvas-status'))
/** user-flow already holds one picture (its `home` card). */
const BASE = 1
const PICTURE = path.join(REPO_ROOT, 'fixtures/canvases/moodboard-calm.png')

interface FileNode {
  id: string
  type: string
  x?: number
  y?: number
  w?: number
  data?: { src?: string }
}
/** The image cards a paste or drop added to the board file (their src is under assets/). */
const imageNodes = (configDir: string, slug: string): FileNode[] => {
  const file = path.join(configDir, 'canvases', `${slug}.json`)
  const nodes: FileNode[] = JSON.parse(fs.readFileSync(file, 'utf8')).nodes
  return nodes.filter((n) => n.type === 'image' && n.data?.src?.startsWith('assets/'))
}

/** A solid PNG of this size, drawn in the page (the clipboard and drops carry real encoded bytes). */
const solidPng = (shell: Page, w: number, h: number, color: string): Promise<string> =>
  shell.evaluate(
    ([ww, hh, c]) => {
      const cv = document.createElement('canvas')
      cv.width = ww as number
      cv.height = hh as number
      const g = cv.getContext('2d')!
      g.fillStyle = c as string
      g.fillRect(0, 0, cv.width, cv.height)
      return cv.toDataURL('image/png').split(',')[1]!
    },
    [w, h, color],
  )

/** Puts one PNG on the system clipboard, as a screenshot or a browser's Copy image does. */
async function copyPng(app: ElectronApplication, b64: string): Promise<void> {
  await app.evaluate(async ({ clipboard, ClipboardItem }, data) => {
    const png = new Blob([Buffer.from(data, 'base64')], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': png })])
  }, b64)
}

/** A drop of these files (or a chat picture's URL) on the board at a point. */
async function dropOn(
  shell: Page,
  at: { x: number; y: number },
  payload: { files?: Array<{ name: string; type: string; b64: string }>; chatUrl?: string },
): Promise<void> {
  await shell.evaluate(
    ([p, point]) => {
      const dt = new DataTransfer()
      for (const f of p.files ?? []) {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
        dt.items.add(new File([bytes], f.name, { type: f.type }))
      }
      if (p.chatUrl) dt.setData('application/x-relay-image', p.chatUrl)
      const target = document.querySelector('.eva-cv-flow')!
      const init = {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      }
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
    },
    [payload, at] as const,
  )
}

async function openBoard(shell: Page): Promise<void> {
  await shell.locator(sel('nav-canvas')).click()
  await shell.locator(sel('canvas-row-user-flow')).click()
  await expect(shell.locator(sel('canvas-board'))).toHaveAttribute('data-slug', 'user-flow')
  await expect(status(shell)).toHaveText('5 nodes · 4 edges · saved', { timeout: 10_000 })
  const toggle = shell.locator(`${sel('panel-toggle')}:visible`).first()
  if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
}

const pictures = (shell: Page) => shell.locator('.eva-cv-flow .react-flow__node img.eva-cv-picture')

test.beforeEach(async ({ shell }) => {
  await expect(shell.locator(sel('dash-hero'))).toBeVisible()
})

test('Cmd+V of a screenshot puts an image card at the pointer, stored in the board assets; undo removes it', async ({
  app,
  configDir,
  shell,
}) => {
  await openBoard(shell)
  const board = shell.locator('.eva-cv-flow')
  const box = (await board.boundingBox())!
  const at = { x: box.x + box.width - 380, y: box.y + box.height - 330 }
  await shell.mouse.move(at.x, at.y)

  await copyPng(app, await solidPng(shell, 600, 300, '#2a9d8f'))
  await shell.keyboard.press('Meta+v')

  await expect(status(shell)).toContainText('6 nodes', { timeout: 10_000 })
  await expect(pictures(shell)).toHaveCount(BASE + 1)
  await expect(status(shell)).toHaveText(/ · saved$/, { timeout: 10_000 })

  const [saved] = imageNodes(configDir, 'user-flow')
  expect(saved!.data!.src).toMatch(/^assets\/user-flow\/[0-9a-f]{16}\.png$/)
  expect(fs.existsSync(path.join(configDir, 'canvases', saved!.data!.src!))).toBe(true)
  // The card sits where the pointer was: its top left is the pointer's board spot.
  const card = (await shell.locator('.react-flow__node.selected').boundingBox())!
  expect(Math.abs(card.x - at.x)).toBeLessThan(3)
  expect(Math.abs(card.y - at.y)).toBeLessThan(3)
  await shell.mouse.move(box.x + 40, box.y + 140)
  fs.mkdirSync(PROOF, { recursive: true })
  await shell.screenshot({ path: path.join(PROOF, 'paste-one.png') })

  await shell.keyboard.press('Meta+z')
  await expect(status(shell)).toContainText('5 nodes')
  await expect.poll(() => imageNodes(configDir, 'user-flow').length).toBe(0)
  await shell.keyboard.press('Meta+Shift+z')
  await expect(status(shell)).toContainText('6 nodes')
})

test('with the pointer off the board a paste lands in the middle of the view; a large screenshot is scaled down', async ({
  app,
  configDir,
  shell,
}) => {
  await openBoard(shell)
  await shell.mouse.move(2, 2)
  await copyPng(app, await solidPng(shell, 5200, 2600, '#e76f51'))
  await shell.locator('.eva-cv-flow').focus()
  await shell.keyboard.press('Meta+v')
  await expect(pictures(shell)).toHaveCount(BASE + 1, { timeout: 15_000 })
  await expect(status(shell)).toHaveText(/ · saved$/, { timeout: 10_000 })

  const [saved] = imageNodes(configDir, 'user-flow')
  const head = fs.readFileSync(path.join(configDir, 'canvases', saved!.data!.src!))
  expect([head.readUInt32BE(16), head.readUInt32BE(20)]).toEqual([2560, 1280])
  const card = (await shell.locator('.react-flow__node.selected').boundingBox())!
  const flow = (await shell.locator('.eva-cv-flow').boundingBox())!
  // A sane card (the picture fits 480 px, at the view's zoom) centered on the view; the card's
  // caption bar makes it a little taller than the picture the row was centered with.
  expect(card.width).toBeLessThanOrEqual(480 * 1.5)
  expect(Math.abs(card.x + card.width / 2 - (flow.x + flow.width / 2))).toBeLessThan(6)
  expect(Math.abs(card.y + card.height / 2 - (flow.y + flow.height / 2))).toBeLessThan(60)
})

test('dropping three image files makes a row of cards; a dropped chat picture and a repeat share files', async ({
  configDir,
  shell,
}) => {
  await openBoard(shell)
  const flow = (await shell.locator('.eva-cv-flow').boundingBox())!
  const files = [
    { name: 'a.png', type: 'image/png', b64: await solidPng(shell, 400, 300, '#264653') },
    { name: 'b.png', type: 'image/png', b64: await solidPng(shell, 300, 300, '#e9c46a') },
    { name: 'notes.txt', type: 'text/plain', b64: btoa('not an image') },
    { name: 'c.png', type: 'image/png', b64: fs.readFileSync(PICTURE).toString('base64') },
  ]
  await dropOn(shell, { x: flow.x + 60, y: flow.y + flow.height - 280 }, { files })
  await expect(pictures(shell)).toHaveCount(BASE + 3, { timeout: 10_000 })
  await expect(status(shell)).toContainText('8 nodes')
  await expect(status(shell)).toHaveText(/ · saved$/, { timeout: 10_000 })

  const row = imageNodes(configDir, 'user-flow')
  expect(row).toHaveLength(3)
  expect(new Set(row.map((n) => n.y)).size).toBe(1)
  expect(row[0]!.x!).toBeLessThan(row[1]!.x!)
  expect(row[1]!.x!).toBeLessThan(row[2]!.x!)
  await shell.screenshot({ path: path.join(PROOF, 'drop-row.png') })

  // A picture dragged out of the chat arrives as its data URL.
  const chatUrl = `data:image/png;base64,${await solidPng(shell, 200, 200, '#f4a261')}`
  await dropOn(shell, { x: flow.x + 500, y: flow.y + 120 }, { chatUrl })
  await expect(pictures(shell)).toHaveCount(BASE + 4, { timeout: 10_000 })
  // One undo step takes the whole dropped row away.
  await shell.keyboard.press('Meta+z')
  await expect(pictures(shell)).toHaveCount(BASE + 3)
  await shell.keyboard.press('Meta+z')
  await expect(pictures(shell)).toHaveCount(BASE)
})

test('Cmd+C on a selected image card puts the picture on the clipboard', async ({ app, shell }) => {
  await openBoard(shell)
  const flow = (await shell.locator('.eva-cv-flow').boundingBox())!
  await dropOn(
    shell,
    { x: flow.x + 80, y: flow.y + flow.height - 300 },
    {
      files: [
        { name: 'a.png', type: 'image/png', b64: await solidPng(shell, 400, 250, '#8338ec') },
      ],
    },
  )
  await expect(pictures(shell)).toHaveCount(BASE + 1, { timeout: 10_000 })
  // Empty the clipboard so only the card's copy can fill it.
  await app.evaluate(({ clipboard }) => clipboard.clear())
  await shell.locator('.react-flow__node.selected').click()
  await shell.keyboard.press('Meta+c')
  await expect
    .poll(
      () =>
        app.evaluate(async ({ clipboard }) =>
          (await clipboard.read()).flatMap((i) => i.types).includes('image/png'),
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
  const size = await app.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read()
    const blob = await item!.getType('image/png')
    const bytes = Buffer.from(await blob.arrayBuffer())
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  })
  expect(size).toEqual([400, 250])
})
