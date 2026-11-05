// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isCommentKey, type KeyLike } from './slash'

const press = (over: Partial<KeyLike> = {}): KeyLike => ({
  key: '/',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  defaultPrevented: false,
  target: document.body,
  ...over,
})

describe('the room frame’s comment key', () => {
  it('is a bare slash, from the header, the sidebar or nothing focused', () => {
    expect(isCommentKey(press())).toBe(true)
    const button = document.createElement('button')
    document.body.append(button)
    expect(isCommentKey(press({ target: button }))).toBe(true)
    expect(isCommentKey(press({ target: null }))).toBe(true)
  })

  it('is not a slash typed in a field, or with a modifier, or one something already took', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      const field = document.createElement(tag)
      document.body.append(field)
      expect(isCommentKey(press({ target: field }))).toBe(false)
    }
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    editable.append(inner)
    document.body.append(editable)
    expect(isCommentKey(press({ target: inner }))).toBe(false)
    expect(isCommentKey(press({ metaKey: true }))).toBe(false)
    expect(isCommentKey(press({ ctrlKey: true }))).toBe(false)
    expect(isCommentKey(press({ altKey: true }))).toBe(false)
    expect(isCommentKey(press({ defaultPrevented: true }))).toBe(false)
    expect(isCommentKey(press({ key: 'a' }))).toBe(false)
  })
})
