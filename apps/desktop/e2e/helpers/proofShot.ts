import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { assertNotBlank, BlankImageError, blit, type Rect } from './image'
import { proofOutDir } from './metrics'

export { BlankImageError }

interface ViewShot {
  bounds: Rect
  png: string
}

/**
 * Composite proof screenshot: the shell page plus every visible native WebContentsView, which
 * page.screenshot() does not include. Rejects near-blank images (whole or per view rect).
 * Writes to proof/<phase>/ only when EVAOS_PROOF=1, else to apps/desktop/test-results/proof/.
 */
export async function proofShot(
  app: ElectronApplication,
  shell: Page,
  name: string,
  opts: { phase?: string } = {},
): Promise<string> {
  // Freshly attached views can capture as blank until their first paint, so retry briefly; a view
  // that is still uniform after the deadline is genuinely blank and the error propagates.
  const deadline = Date.now() + 1500
  for (;;) {
    try {
      return await capture()
    } catch (err) {
      if (!(err instanceof BlankImageError) || Date.now() > deadline) throw err
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  async function capture(): Promise<string> {
    const base = PNG.sync.read(await shell.screenshot())
    // electronApp.evaluate callbacks run in main without `require`; use the test global only.
    const views: ViewShot[] = await app.evaluate(async () => {
      const t = (
        globalThis as unknown as {
          __evaosTest: {
            views(): Array<{
              getVisible(): boolean
              getBounds(): { x: number; y: number; width: number; height: number }
              webContents: { capturePage(): Promise<{ toPNG(): Buffer }> }
            }>
          }
        }
      ).__evaosTest
      return Promise.all(
        t
          .views()
          .filter((v) => v.getVisible())
          .map(async (v) => ({
            bounds: v.getBounds(),
            png: (await v.webContents.capturePage()).toPNG().toString('base64'),
          })),
      )
    })
    const innerWidth = await shell.evaluate(() => window.innerWidth)
    const scale = base.width / innerWidth
    const rects: Rect[] = []
    for (const v of views) {
      const x = Math.round(v.bounds.x * scale)
      const y = Math.round(v.bounds.y * scale)
      const src = PNG.sync.read(Buffer.from(v.png, 'base64'))
      blit(base, src, x, y)
      rects.push({ x, y, width: src.width, height: src.height })
    }
    assertNotBlank(base, rects)
    const dir = proofOutDir(opts.phase ?? 'phase-1')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${name}.png`)
    fs.writeFileSync(file, PNG.sync.write(base))
    return file
  }
}
