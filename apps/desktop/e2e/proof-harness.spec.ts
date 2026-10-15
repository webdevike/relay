import * as fs from 'node:fs'
import { PNG } from 'pngjs'
import { expect, test } from './fixtures'
import { BlankImageError, proofShot } from './helpers/proofShot'

interface TestView {
  setBounds(b: { x: number; y: number; width: number; height: number }): void
  webContents: { loadURL(url: string): Promise<void>; close(): void }
}
interface TestGlobal {
  win: { contentView: { addChildView(v: TestView): void; removeChildView(v: TestView): void } }
  extraViews: TestView[]
}

const GRADIENT =
  'data:text/html,<body style="margin:0;background:linear-gradient(90deg,%23f00,%2300f)"><h1>PROOF VIEW</h1></body>'
const WHITE = 'data:text/html,<body style="background:%23fff"></body>'

test('proofShot composites native views and rejects blank ones', async ({ app, shell }) => {
  await app.evaluate(({ WebContentsView }, url) => {
    const t = (globalThis as unknown as { __evaosTest: TestGlobal }).__evaosTest
    const v = new WebContentsView()
    t.win.contentView.addChildView(v)
    v.setBounds({ x: 400, y: 100, width: 300, height: 200 })
    t.extraViews.push(v)
    return v.webContents.loadURL(url)
  }, GRADIENT)

  const file = await proofShot(app, shell, 'harness-composite')
  const png = PNG.sync.read(fs.readFileSync(file))
  const scale = png.width / (await shell.evaluate(() => window.innerWidth))
  const cx = Math.round((400 + 150) * scale)
  const cy = Math.round((100 + 100) * scale)
  const i = (cy * png.width + cx) * 4
  const px = [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
  expect(px, 'view centre must not be the shell background').not.toEqual([0x17, 0x18, 0x1c])
  expect(
    await app.evaluate(
      () =>
        (globalThis as unknown as { __evaosTest: { views(): unknown[] } }).__evaosTest.views()
          .length,
    ),
  ).toBeGreaterThanOrEqual(1)

  await app.evaluate((_e, url) => {
    const t = (globalThis as unknown as { __evaosTest: TestGlobal }).__evaosTest
    return t.extraViews[0].webContents.loadURL(url)
  }, WHITE)
  await expect(proofShot(app, shell, 'harness-blank')).rejects.toBeInstanceOf(BlankImageError)

  await app.evaluate(() => {
    const t = (globalThis as unknown as { __evaosTest: TestGlobal }).__evaosTest
    const v = t.extraViews.pop()!
    t.win.contentView.removeChildView(v)
    v.webContents.close()
  })
})
