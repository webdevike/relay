import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createImageReader, sniffImage } from './images'

const repo = path.resolve(__dirname, '../../../../..')
const png = fs.readFileSync(path.join(repo, 'fixtures/canvases/moodboard-calm.png'))
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

function setup(download = vi.fn(async (_url: string) => png)) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-canvas-img-')))
  roots.push(root)
  const dir = path.join(root, 'canvases')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'shot.png'), png)
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello')
  fs.writeFileSync(path.join(dir, 'fake.png'), 'not really a png')
  const cacheDir = path.join(root, 'cache')
  return { root, dir, cacheDir, download, reader: createImageReader({ dir, cacheDir, download }) }
}

describe('canvas images', () => {
  it('reads a local png relative to the boards folder or by absolute path', async () => {
    const { reader, dir } = setup()
    const rel = await reader.read('shot.png')
    expect(rel.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(Buffer.from(rel.dataUrl.split(',')[1]!, 'base64').equals(png)).toBe(true)
    expect([rel.width, rel.height]).toEqual([240, 160])
    expect(await reader.read(path.join(dir, 'shot.png'))).toEqual(rel)
  })

  it('refuses files that are not images by their bytes, and missing files', async () => {
    const { reader } = setup()
    await expect(reader.read('notes.txt')).rejects.toMatchObject({ code: 'unsupported' })
    await expect(reader.read('fake.png')).rejects.toMatchObject({ code: 'unsupported' })
    await expect(reader.read('missing.png')).rejects.toMatchObject({ code: 'not-found' })
    await expect(reader.read('.')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('downloads a URL once and serves it from the cache', async () => {
    const { reader, download, cacheDir } = setup()
    const url = 'https://cdn.example.com/a.png'
    const [a, b] = await Promise.all([reader.read(url), reader.read(url)])
    expect(a).toEqual(b)
    expect(await reader.read(url)).toEqual(a)
    expect(download).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(cacheDir)).toHaveLength(1)
    expect(fs.readdirSync(cacheDir)[0]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('does not cache a download that is not an image', async () => {
    const { reader, cacheDir } = setup(vi.fn(async () => Buffer.from('<html>')))
    await expect(reader.read('https://example.com/page')).rejects.toMatchObject({
      code: 'unsupported',
    })
    expect(fs.existsSync(cacheDir)).toBe(false)
  })

  it('sniffs gif, webp and jpeg sizes', () => {
    const gif = Buffer.from('474946383961' + '0a00' + '0500', 'hex')
    expect(sniffImage(gif)).toEqual({ mime: 'image/gif', width: 10, height: 5 })
    const vp8x = Buffer.alloc(30)
    vp8x.write('RIFF', 0, 'ascii')
    vp8x.write('WEBPVP8X', 8, 'ascii')
    vp8x.writeUIntLE(99, 24, 3)
    vp8x.writeUIntLE(49, 27, 3)
    expect(sniffImage(vp8x)).toEqual({ mime: 'image/webp', width: 100, height: 50 })
    const jpeg = Buffer.from('ffd8ffe000044a46ffc0000b080020004001011100', 'hex')
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', width: 64, height: 32 })
    expect(sniffImage(Buffer.from('hello world'))).toBeNull()
  })
})
