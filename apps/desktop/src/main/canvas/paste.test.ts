import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_STORED_EDGE, storeBoardImage, type Rescale } from './paste'

const repo = path.resolve(__dirname, '../../../../..')
const png = fs.readFileSync(path.join(repo, 'fixtures/canvases/moodboard-calm.png'))

/** A PNG header that claims this size (what sniffImage reads); the rest is filler. */
function pngOfSize(width: number, height: number): Buffer {
  const b = Buffer.alloc(64)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const boards = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-paste-'))
  dirs.push(d)
  return d
}
const never: Rescale = () => {
  throw new Error('rescale must not run')
}

describe('storeBoardImage', () => {
  it('keeps the image under assets/<slug>/ by content, so the same picture is one file', async () => {
    const dir = boards()
    const a = await storeBoardImage({ dir, slug: 'plan', bytes: png, rescale: never })
    const b = await storeBoardImage({ dir, slug: 'plan', bytes: png, rescale: never })
    expect(a).toEqual(b)
    expect(a.src).toMatch(/^assets\/plan\/[0-9a-f]{16}\.png$/)
    expect([a.width, a.height]).toEqual([240, 160])
    expect(fs.readdirSync(path.join(dir, 'assets/plan'))).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, a.src)).equals(png)).toBe(true)
  })

  it('scales a PNG past the edge limit down and stores the scaled bytes', async () => {
    const dir = boards()
    const small = Buffer.from('scaled-bytes')
    const rescale = vi.fn<Rescale>(() => ({ bytes: small, width: 2560, height: 1280 }))
    const out = await storeBoardImage({
      dir,
      slug: 'plan',
      bytes: pngOfSize(5120, 2560),
      rescale,
    })
    expect(rescale).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', MAX_STORED_EDGE)
    expect([out.width, out.height]).toEqual([2560, 1280])
    expect(fs.readFileSync(path.join(dir, out.src)).equals(small)).toBe(true)
  })

  it('leaves an image at the limit untouched', async () => {
    const dir = boards()
    const at = pngOfSize(MAX_STORED_EDGE, 100)
    const out = await storeBoardImage({ dir, slug: 'plan', bytes: at, rescale: never })
    expect(fs.readFileSync(path.join(dir, out.src)).equals(at)).toBe(true)
  })

  it('refuses bytes that are not an image', async () => {
    await expect(
      storeBoardImage({
        dir: boards(),
        slug: 'plan',
        bytes: Buffer.from('hello there, not an image'),
        rescale: never,
      }),
    ).rejects.toMatchObject({ code: 'unsupported' })
  })
})
