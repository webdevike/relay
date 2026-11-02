/**
 * A minimal QR Code encoder: byte mode, error correction L, versions 1 to 5 (up to 106 bytes),
 * which fits the TestFlight and App Store links the wizard shows. Follows ISO/IEC 18004.
 */

// Version 1-5 at level L: [data codewords, error-correction codewords]; one block each.
const VERSIONS: ReadonlyArray<readonly [number, number]> = [
  [19, 7],
  [34, 10],
  [55, 15],
  [80, 20],
  [108, 26],
]

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function reedSolomon(data: number[], degree: number): number[] {
  const divisor: number[] = new Array<number>(degree).fill(0)
  divisor[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMul(divisor[j]!, root)
      if (j + 1 < degree) divisor[j]! ^= divisor[j + 1]!
    }
    root = gfMul(root, 2)
  }
  const result: number[] = new Array<number>(degree).fill(0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMul(coef, factor)
    })
  }
  return result
}

function codewords(bytes: Uint8Array, dataCw: number, eccCw: number): number[] {
  const bits: number[] = []
  const put = (value: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, 8)
  bytes.forEach((b) => put(b, 8))
  put(0, Math.min(4, dataCw * 8 - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(''), 2))
  }
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xec ^ 0x11) data.push(pad)
  return [...data, ...reedSolomon(data, eccCw)]
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function penalty(m: boolean[][]): number {
  const n = m.length
  let score = 0
  const lines: string[] = []
  for (let a = 0; a < n; a++) {
    lines.push(m[a]!.map((v) => (v ? '1' : '0')).join(''))
    lines.push(m.map((row) => (row[a] ? '1' : '0')).join(''))
  }
  for (const line of lines) {
    score += (line.match(/(0{5,}|1{5,})/g) ?? []).reduce((s, run) => s + run.length - 2, 0)
    score += 40 * (line.match(/(?=(10111010000|00001011101))/g) ?? []).length
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y]![x]
      if (v === m[y]![x + 1] && v === m[y + 1]![x] && v === m[y + 1]![x + 1]) score += 3
    }
  }
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0)
  score += 10 * (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1)
  return score
}

/** The module grid (true = dark) for `text`; throws when it needs more than version 5. */
export function qrModules(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  const ver = VERSIONS.findIndex(([dataCw]) => bytes.length <= dataCw - 2)
  if (ver < 0) throw new Error('Text too long for the QR encoder')
  const [dataCw, eccCw] = VERSIONS[ver]!
  const size = 17 + 4 * (ver + 1)
  const all = codewords(bytes, dataCw, eccCw)

  const base: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const setFn = (x: number, y: number, dark: boolean): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    base[y]![x] = dark
    fn[y]![x] = true
  }
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0)
    setFn(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        setFn(cx + dx, cy + dy, d !== 2 && d !== 4)
      }
    }
  }
  if (ver >= 1) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(size - 7 + dx, size - 7 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }
  // Reserve the format areas (drawn per mask below) so data skips them.
  const drawFormat = (m: boolean[][], mask: number): void => {
    const data = (1 << 3) | mask // level L = 01
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0
    const set = (x: number, y: number, v: boolean): void => {
      m[y]![x] = v
      fn[y]![x] = true
    }
    for (let i = 0; i <= 5; i++) set(8, i, bit(i))
    set(8, 7, bit(6))
    set(8, 8, bit(7))
    set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i))
    set(8, size - 8, true)
  }
  drawFormat(base, 0)

  // Zigzag the codeword bits into the free modules.
  const placed = base.map((r) => [...r])
  let bitIx = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert
        if (!fn[y]![x] && bitIx < all.length * 8) {
          placed[y]![x] = ((all[bitIx >>> 3]! >>> (7 - (bitIx & 7))) & 1) !== 0
          bitIx++
        }
      }
    }
  }

  let best: boolean[][] = placed
  let bestScore = Infinity
  MASKS.forEach((rule, mask) => {
    const m = placed.map((r) => [...r])
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (!fn[y]![x] && rule(x, y)) m[y]![x] = !m[y]![x]
    }
    drawFormat(m, mask)
    const s = penalty(m)
    if (s < bestScore) {
      bestScore = s
      best = m
    }
  })
  return best
}

/** The code as a standalone SVG string (4-module quiet zone, black on white so phones can scan it). */
export function qrSvg(text: string): string {
  const m = qrModules(text)
  const quiet = 4
  const n = m.length + quiet * 2
  let path = ''
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`
    }),
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
}
