import { beforeEach, describe, expect, it } from 'vitest'
import {
  chatScrollOf,
  rememberChatScroll,
  requestChatScroll,
  resetChatScrollForTests,
  takeChatScrollRequest,
} from './chat-scroll'

beforeEach(() => resetChatScrollForTests())

describe('chat scroll memory', () => {
  it('keeps the last place per file, never for a chat without one', () => {
    rememberChatScroll('/a.jsonl', { offset: 10, pinned: false })
    rememberChatScroll('/a.jsonl', { offset: 30, pinned: false })
    rememberChatScroll('/b.jsonl', { offset: 0, pinned: true })
    rememberChatScroll('', { offset: 5, pinned: false })
    expect(chatScrollOf('/a.jsonl')).toEqual({ offset: 30, pinned: false })
    expect(chatScrollOf('/b.jsonl')).toEqual({ offset: 0, pinned: true })
    expect(chatScrollOf('')).toBeNull()
  })

  it('keeps the 200 files seen most recently', () => {
    for (let i = 0; i < 201; i++) rememberChatScroll(`/${i}.jsonl`, { offset: i, pinned: false })
    expect(chatScrollOf('/0.jsonl')).toBeNull()
    expect(chatScrollOf('/1.jsonl')).toEqual({ offset: 1, pinned: false })
    // Seeing a file again makes it recent.
    rememberChatScroll('/1.jsonl', { offset: 2, pinned: false })
    rememberChatScroll('/new.jsonl', { offset: 0, pinned: true })
    expect(chatScrollOf('/1.jsonl')).toEqual({ offset: 2, pinned: false })
    expect(chatScrollOf('/2.jsonl')).toBeNull()
  })

  it('hands a requested place out once', () => {
    requestChatScroll('/a.jsonl', { offset: 99, pinned: false })
    expect(takeChatScrollRequest('/b.jsonl')).toBeNull()
    expect(takeChatScrollRequest('/a.jsonl')).toEqual({ offset: 99, pinned: false })
    expect(takeChatScrollRequest('/a.jsonl')).toBeNull()
  })
})
