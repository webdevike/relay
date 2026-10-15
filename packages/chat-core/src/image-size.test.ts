import { describe, expect, it } from 'vitest'
import { imageSize } from './image-size'

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s+/g, ''), 'hex'))
const ascii = (s: string) => Array.from(Buffer.from(s, 'latin1'))

describe('imageSize', () => {
  it('reads a 1x1 PNG', () => {
    const png = hex('89504e470d0a1a0a 0000000d 49484452 00000001 00000001 08060000 00')
    expect(imageSize(png)).toEqual({ width: 1, height: 1, mime: 'image/png' })
  })
  it('reads a 2x3 GIF', () => {
    expect(imageSize(Uint8Array.from([...ascii('GIF89a'), 2, 0, 3, 0, 0, 0, 0]))).toEqual({
      width: 2,
      height: 3,
      mime: 'image/gif',
    })
  })
  it('reads a baseline JPEG past an APP0 segment', () => {
    const jpeg = hex('ffd8 ffe0 0004 0000 ffc0 0011 08 0020 0040 03 000000 000000 000000')
    expect(imageSize(jpeg)).toEqual({ width: 0x40, height: 0x20, mime: 'image/jpeg' })
  })
  it('reads VP8X, VP8L and VP8 WebP', () => {
    const riff = (chunk: string, body: number[]) =>
      Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii(chunk), 0, 0, 0, 0, ...body])
    // VP8X: flags(4) then width-1 (3 bytes) height-1 (3 bytes)
    expect(imageSize(riff('VP8X', [0, 0, 0, 0, 99, 0, 0, 49, 0, 0]))).toEqual({ width: 100, height: 50, mime: 'image/webp' })
    // VP8L: 0x2f then 14 bit w-1, 14 bit h-1
    const w = 9
    const h = 19
    const bits = w | (h << 14)
    expect(
      imageSize(riff('VP8L', [0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255])),
    ).toEqual({ width: 10, height: 20, mime: 'image/webp' })
    // VP8: 3 byte frame tag, start code, then 16 bit w, h
    expect(imageSize(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 32, 0]))).toEqual({
      width: 64,
      height: 32,
      mime: 'image/webp',
    })
  })
  it('returns null for truncated or unknown bytes', () => {
    expect(imageSize(hex('89504e47'))).toBeNull()
    expect(imageSize(hex('ffd8ffe0'))).toBeNull()
    expect(imageSize(Uint8Array.from(ascii('RIFF....WEBPVP8X')))).toBeNull()
    expect(imageSize(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull()
    expect(imageSize(new Uint8Array())).toBeNull()
  })
})
