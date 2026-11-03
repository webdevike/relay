// PNG, JPEG, GIF and WebP dimensions from header bytes. Bounds-checked: truncated input is null.

export function imageSize(
  bytes: Uint8Array,
): { width: number; height: number; mime: string } | null {
  const b = bytes
  const n = b.length
  const u16be = (o: number) => ((b[o] as number) << 8) | (b[o + 1] as number)
  const u16le = (o: number) => (b[o] as number) | ((b[o + 1] as number) << 8)
  const u24le = (o: number) => u16le(o) | ((b[o + 2] as number) << 16)
  const u32be = (o: number) => u16be(o) * 65536 + u16be(o + 2)
  const ascii = (o: number, s: string) => {
    if (o + s.length > n) return false
    for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false
    return true
  }
  const ok = (width: number, height: number, mime: string) =>
    width > 0 && height > 0 ? { width, height, mime } : null

  // PNG: signature, IHDR at 16.
  if (n >= 24 && b[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) {
    return ok(u32be(16), u32be(20), 'image/png')
  }
  // GIF: logical screen size at 6.
  if (n >= 10 && (ascii(0, 'GIF87a') || ascii(0, 'GIF89a'))) {
    return ok(u16le(6), u16le(8), 'image/gif')
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (n >= 16 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8X') && n >= 30) return ok(u24le(24) + 1, u24le(27) + 1, 'image/webp')
    if (ascii(12, 'VP8L') && n >= 25 && b[20] === 0x2f) {
      const bits =
        (b[21] as number) |
        ((b[22] as number) << 8) |
        ((b[23] as number) << 16) |
        ((b[24] as number) * 16777216)
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 'image/webp')
    }
    if (ascii(12, 'VP8 ') && n >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff, 'image/webp')
    }
    return null
  }
  // JPEG: walk segments to a SOFn marker.
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 4 <= n) {
      if (b[o] !== 0xff) return null
      const marker = b[o + 1] as number
      if (marker === 0xff) {
        o++
        continue
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2
        continue
      }
      const len = u16be(o + 2)
      if (len < 2) return null
      const sof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (sof) {
        if (o + 9 > n) return null
        return ok(u16be(o + 7), u16be(o + 5), 'image/jpeg')
      }
      o += 2 + len
    }
    return null
  }
  return null
}
