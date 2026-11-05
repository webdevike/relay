import { describe, expect, it } from 'vitest'
import { userImageUrls } from './image-urls'

describe('userImageUrls', () => {
  it('takes a bare webp link', () => {
    expect(userImageUrls('https://pixie.haus/sprites/a/b.webp')).toEqual({
      urls: ['https://pixie.haus/sprites/a/b.webp'],
      rest: '',
    })
  })
  it('keeps the words around a jpg with a query', () => {
    const text = 'use this https://thumbs.dreamstime.com/z/x-1.jpg?w=400 please'
    expect(userImageUrls(text)).toEqual({
      urls: ['https://thumbs.dreamstime.com/z/x-1.jpg?w=400'],
      rest: 'use this please',
    })
  })
  it('leaves ordinary links and plain text alone', () => {
    expect(userImageUrls('see https://example.com/page')).toEqual({
      urls: [],
      rest: 'see https://example.com/page',
    })
  })
  it('dedupes and ignores trailing punctuation', () => {
    expect(userImageUrls('https://a.io/x.png, https://a.io/x.png.').urls).toEqual([
      'https://a.io/x.png',
    ])
  })
})
