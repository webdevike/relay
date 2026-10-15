import { describe, expect, it } from 'vitest'
import { ChatMessageSchema } from './message'

const base = { id: 'a', role: 'user', text: 'x', detail: '', streaming: false }

describe('ChatMessageSchema images', () => {
  it('still parses label-only images', () => {
    expect(ChatMessageSchema.safeParse({ ...base, images: [{ label: 'Image' }] }).success).toBe(
      true,
    )
  })
  it('parses images with src and dimensions', () => {
    const r = ChatMessageSchema.safeParse({
      ...base,
      images: [{ label: 'Image 1', src: 'data:image/png;base64,AAA', width: 2, height: 3 }],
    })
    expect(r.success).toBe(true)
  })
})
