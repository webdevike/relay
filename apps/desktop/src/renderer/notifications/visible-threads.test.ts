import { describe, expect, it } from 'vitest'
import { placeOf } from '@evaos/shell-core'
import { threadsOf } from './visible-threads'

describe('threadsOf', () => {
  it('names the assistants and chats the window shows, and nothing else', () => {
    expect(
      threadsOf([
        placeOf('agent:nova'),
        placeOf('chat', { chat: '/s/1_abc.jsonl' }),
        placeOf('chat'),
        placeOf('jobs'),
        placeOf('agent:nova'),
      ]),
    ).toEqual(['assistant:nova', 'chat:/s/1_abc.jsonl'])
  })
})
