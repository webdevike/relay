// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCEPTED_IMAGE_TYPES, readImageFiles } from './image-input'

beforeEach(() => {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x') }))
})
afterEach(() => vi.unstubAllGlobals())

describe('readImageFiles', () => {
  it('accepts png, jpeg, gif and webp', () => {
    expect([...ACCEPTED_IMAGE_TYPES]).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ])
  })

  it('returns bare base64 and a preview url', async () => {
    const f = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    const r = await readImageFiles([f])
    expect(r.rejected).toBeNull()
    expect(r.images).toEqual([
      { mimeType: 'image/png', data: 'AQID', name: 'a.png', previewUrl: 'blob:x' },
    ])
  })

  it('rejects a text file as not-image and keeps the valid ones', async () => {
    const png = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const txt = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const r = await readImageFiles([txt, png])
    expect(r.rejected).toBe('not-image')
    expect(r.images).toHaveLength(1)
  })

  it('encodes at most `limit` files and reports truncation', async () => {
    const mk = (n: string) => new File([new Uint8Array([1])], n, { type: 'image/png' })
    const r = await readImageFiles([mk('a.png'), mk('b.png'), mk('c.png')], 2)
    expect(r.images.map((i) => i.name)).toEqual(['a.png', 'b.png'])
    expect(r.truncated).toBe(true)
  })

  it('rejects an svg (not in the allow-list)', async () => {
    const svg = new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' })
    expect((await readImageFiles([svg])).rejected).toBe('not-image')
  })

  it('rejects a file over 20 MB without encoding it', async () => {
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    const r = await readImageFiles([big])
    expect(r.rejected).toBe('too-large')
    expect(r.images).toEqual([])
  })
})
