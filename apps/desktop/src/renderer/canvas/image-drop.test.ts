import { describe, expect, it } from 'vitest'
import {
  CARD_MAX,
  IMAGE_DRAG_TYPE,
  ROW_GAP,
  fitImage,
  mayHoldImage,
  readTransferImages,
  rowPositions,
} from './image-drop'

const transfer = (parts: {
  files?: File[]
  types?: string[]
  data?: Record<string, string>
}): DataTransfer =>
  ({
    files: parts.files ?? [],
    items: (parts.files ?? []).map((f) => ({
      kind: 'file',
      type: f.type,
      getAsFile: () => f,
    })),
    types: parts.types ?? [],
    getData: (t: string) => parts.data?.[t] ?? '',
  }) as unknown as DataTransfer

describe('fitImage', () => {
  it('scales a large picture into the card box at its own ratio', () => {
    expect(fitImage(2000, 1000)).toEqual({ w: CARD_MAX, h: 240 })
    expect(fitImage(1000, 2000)).toEqual({ w: 240, h: CARD_MAX })
  })
  it('never enlarges a small one, but keeps a tiny icon legible', () => {
    expect(fitImage(300, 200)).toEqual({ w: 300, h: 200 })
    expect(fitImage(32, 32)).toEqual({ w: 120, h: 120 })
  })
  it('falls back to a fixed width when the size is unknown', () => {
    expect(fitImage(null, null)).toEqual({ w: 320, h: null })
  })
})

describe('rowPositions', () => {
  const sizes = [
    { w: 100, h: 50 },
    { w: 200, h: 80 },
  ]
  it('starts a row at the pointer and steps by width plus gap', () => {
    expect(rowPositions(sizes, { x: 10, y: 20 }, false)).toEqual([
      [10, 20],
      [10 + 100 + ROW_GAP, 20],
    ])
  })
  it('centers the whole row on the view middle', () => {
    const [first, second] = rowPositions(sizes, { x: 0, y: 0 }, true)
    const total = 300 + ROW_GAP
    expect(first).toEqual([Math.round(-total / 2), -40])
    expect(second![0] + 200 - first![0]).toBe(total)
  })
})

describe('readTransferImages', () => {
  it('takes every image file in order and skips other files', async () => {
    const a = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    const t = new File(['x'], 'notes.txt', { type: 'text/plain' })
    const b = new File([new Uint8Array([4])], 'b.jpg', { type: 'image/jpeg' })
    const out = await readTransferImages(transfer({ files: [a, t, b] }))
    expect(out).toEqual([btoa('\x01\x02\x03'), btoa('\x04')])
  })
  it('reads the chat picture from its drag URL when no file came along', async () => {
    const url = 'data:image/png;base64,AQID'
    const out = await readTransferImages(transfer({ data: { [IMAGE_DRAG_TYPE]: url } }))
    expect(out).toEqual(['AQID'])
  })
  it('finds nothing in a text-only payload', async () => {
    expect(await readTransferImages(transfer({ data: { 'text/plain': 'hi' } }))).toEqual([])
  })
})

describe('mayHoldImage', () => {
  it('accepts files and the chat picture, not plain text', () => {
    expect(mayHoldImage(transfer({ types: ['Files'] }))).toBe(true)
    expect(mayHoldImage(transfer({ types: [IMAGE_DRAG_TYPE] }))).toBe(true)
    expect(mayHoldImage(transfer({ types: ['text/plain'] }))).toBe(false)
  })
})
