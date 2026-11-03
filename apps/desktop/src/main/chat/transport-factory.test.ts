import { describe, expect, it } from 'vitest'
import type { MainContext } from '../context'
import { ClaudeBridgeTransport } from './claude-transport'
import { OmpStdioTransport } from './omp-transport'
import { createChatTransport } from './transport-factory'

function ctxWith(chat: Record<string, unknown>): MainContext {
  return {
    env: { ompBin: '/bin/omp', claudeBridgeBin: '/bin/bridge', live: false },
    config: { readJson: (_n: string, d: unknown) => (_n === 'chat.json' ? chat : d) },
  } as unknown as MainContext
}

describe('createChatTransport', () => {
  it('defaults to an omp stdio transport', () => {
    const r = createChatTransport(ctxWith({}))
    expect(r.harness).toBe('omp')
    expect(r.transport).toBeInstanceOf(OmpStdioTransport)
    expect(r.transport).not.toBeInstanceOf(ClaudeBridgeTransport)
    expect(r.transport.kind).toBe('omp-stdio')
  })

  it('uses the Claude bridge when chat.json says claude', () => {
    const r = createChatTransport(ctxWith({ harness: 'claude' }))
    expect(r.harness).toBe('claude')
    expect(r.transport).toBeInstanceOf(ClaudeBridgeTransport)
    expect(r.transport.kind).toBe('claude')
  })

  it('reads the harness at call time', () => {
    const chat: Record<string, unknown> = { harness: 'omp' }
    const ctx = ctxWith(chat)
    expect(createChatTransport(ctx).harness).toBe('omp')
    chat.harness = 'claude'
    expect(createChatTransport(ctx).harness).toBe('claude')
  })
})
