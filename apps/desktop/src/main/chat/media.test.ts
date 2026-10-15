import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBlobImage } from './media'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==',
  'base64',
)
const H1 = '1'.repeat(64)
const H2 = '2'.repeat(64)
const H3 = '3'.repeat(64)
const H4 = '4'.repeat(64)
const tok = (h: string): string => `blob:sha256:${h}`

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-media-'))
  fs.mkdirSync(path.join(dir, 'blobs'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code
  }
  return undefined
}

describe('readBlobImage', () => {
  it('returns a data URL with sniffed mime and size, with or without extension', () => {
    fs.writeFileSync(path.join(dir, 'blobs', `${H1}.png`), PNG)
    fs.writeFileSync(path.join(dir, 'blobs', H2), PNG)
    for (const h of [H1, H2]) {
      const r = readBlobImage(dir, tok(h))
      expect(r.dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
      expect([r.width, r.height]).toEqual([1, 1])
    }
  })

  it('missing blob is image-not-found', () => {
    expect(code(() => readBlobImage(dir, tok(H3)))).toBe('image-not-found')
  })

  it('over 20 MB is image-too-large', () => {
    const f = path.join(dir, 'blobs', `${H3}.png`)
    fs.writeFileSync(f, PNG)
    fs.truncateSync(f, 21 * 1024 * 1024)
    expect(code(() => readBlobImage(dir, tok(H3)))).toBe('image-too-large')
  })

  it('non-image bytes are not-an-image', () => {
    fs.writeFileSync(
      path.join(dir, 'blobs', `${H4}.png`),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    )
    expect(code(() => readBlobImage(dir, tok(H4)))).toBe('not-an-image')
  })

  it('bad tokens never reach the file system', () => {
    fs.writeFileSync(path.join(dir, 'secret'), PNG)
    for (const bad of [
      'blob:sha256:../secret',
      'blob:sha256:' + 'A'.repeat(64),
      '/etc/passwd',
      `${tok(H1)}/..`,
    ]) {
      expect(code(() => readBlobImage(dir, bad))).toBe('image-not-found')
    }
  })

  it('a symlink escaping the blobs directory is refused', () => {
    fs.writeFileSync(path.join(dir, 'outside.png'), PNG)
    fs.symlinkSync(path.join(dir, 'outside.png'), path.join(dir, 'blobs', `${H1}.png`))
    expect(code(() => readBlobImage(dir, tok(H1)))).toBe('image-not-found')
  })
})
