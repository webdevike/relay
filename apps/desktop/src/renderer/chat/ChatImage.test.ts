import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn(
  async (..._a: unknown[]) => ({ ok: true, value: { dataUrl: 'data:x' } }) as unknown,
)
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))

import { BLOB_CACHE_MAX, clearBlobCache, loadBlob } from './ChatImage'

const tok = (n: number) => `blob:sha256:${n.toString(16).padStart(64, '0')}`

beforeEach(() => {
  invoke.mockClear()
  clearBlobCache()
})

describe('loadBlob', () => {
  it('retries after a failed read instead of caching the failure', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'missing' } })
    expect(await loadBlob(tok(1))).toBeNull()
    expect(await loadBlob(tok(1))).toBe('data:x')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('reads a cached token once', async () => {
    await loadBlob(tok(2))
    await loadBlob(tok(2))
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('evicts the least recently used entry past the cap', async () => {
    for (let i = 0; i <= BLOB_CACHE_MAX; i++) await loadBlob(tok(i))
    invoke.mockClear()
    await loadBlob(tok(BLOB_CACHE_MAX))
    expect(invoke).not.toHaveBeenCalled()
    await loadBlob(tok(0))
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
