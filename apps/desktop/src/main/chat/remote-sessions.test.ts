import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blobAgentDirs, readBlobImage } from './media'
import { HEAD_BYTES, RECENT_MS, RemoteSessions, remoteSessionsDir } from './remote-sessions'

type Frame = Record<string, unknown>

/** A connected host holding `files` (by name) and `blobs` (by hash), answering as Relay Host does. */
class FakeHost {
  files = new Map<string, Buffer>()
  mtimes = new Map<string, number>()
  blobs = new Map<string, Buffer>()
  sent: Frame[] = []
  private cb: ((f: Frame) => void) | null = null
  onFrame(cb: (f: Frame) => void): () => void {
    this.cb = cb
    return () => (this.cb = null)
  }
  sendFrame(f: Frame): boolean {
    this.sent.push(f)
    this.answer(f)
    return true
  }
  push(f: Frame): void {
    this.cb?.(f)
  }
  private answer(f: Frame): void {
    if (f.t === 'sessions.list') {
      const files = [...this.files].map(([name, b]) => ({
        dir: '--Users-ike-Eva--',
        name,
        size: b.length,
        mtime: this.mtimes.get(name) ?? Date.now(),
      }))
      this.push({ t: 'sessions.list', files })
    } else if (f.t === 'session.read') {
      const key = typeof f.parent === 'string' ? `${f.parent}/${f.name}` : (f.name as string)
      const b = this.files.get(key)
      const offset = f.offset as number
      const end = typeof f.limit === 'number' ? offset + f.limit : undefined
      this.push({
        t: 'session.chunk',
        dir: f.dir,
        ...(typeof f.parent === 'string' && { parent: f.parent }),
        name: f.name,
        offset,
        data: b ? b.subarray(offset, end).toString('base64') : null,
        size: b?.length ?? 0,
      })
    } else if (f.t === 'blob.read') {
      const b = this.blobs.get(f.hash as string)
      this.push({
        t: 'blob.data',
        hash: f.hash,
        mime: b ? 'image/png' : null,
        data: b?.toString('base64') ?? null,
      })
    }
  }
}

const OLD = Date.now() - RECENT_MS * 2

let tmp: string
let host: FakeHost
let mirror: RemoteSessions
const local = (name: string): string => path.join(remoteSessionsDir(tmp), name)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-sessions-'))
  host = new FakeHost()
  mirror = new RemoteSessions(host, remoteSessionsDir(tmp))
})
afterEach(() => {
  mirror.stop()
  vi.useRealTimers()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('RemoteSessions', () => {
  it('mirrors recent files in full and only the head of old ones, with the host mtime', async () => {
    const big = Buffer.from(Array.from({ length: 4000 }, (_, i) => `{"n":${i}}\n`).join(''))
    expect(big.length).toBeGreaterThan(HEAD_BYTES)
    host.files.set('a_recent.jsonl', big)
    host.files.set('b_old.jsonl', big)
    host.mtimes.set('b_old.jsonl', OLD)
    mirror.start()
    expect(fs.readFileSync(local('a_recent.jsonl'))).toEqual(big)
    const head = fs.readFileSync(local('b_old.jsonl'))
    expect(head.length).toBeLessThanOrEqual(HEAD_BYTES)
    expect(head.toString().endsWith('\n')).toBe(true)
    expect(big.subarray(0, head.length)).toEqual(head)
    expect(Math.round(fs.statSync(local('b_old.jsonl')).mtimeMs)).toBe(OLD)
  })

  it('fetches an old file in full on open', async () => {
    const big = Buffer.from('x'.repeat(10) + '\n' + 'y'.repeat(HEAD_BYTES * 2) + '\n')
    host.files.set('old.jsonl', big)
    host.mtimes.set('old.jsonl', OLD)
    mirror.start()
    expect(fs.readFileSync(local('old.jsonl')).toString()).toBe('x'.repeat(10) + '\n')
    await mirror.open(local('old.jsonl'))
    expect(fs.readFileSync(local('old.jsonl'))).toEqual(big)
  })

  it('tails a grown file by offset after activity, appending exactly the new bytes', async () => {
    host.files.set('live.jsonl', Buffer.from('{"a":1}\n'))
    mirror.start()
    host.files.set('live.jsonl', Buffer.from('{"a":1}\n{"b":2}\n'))
    host.sent = []
    host.push({ t: 'agents.delta' })
    vi.advanceTimersByTime(1000)
    expect(host.sent).toContainEqual(expect.objectContaining({ t: 'session.read', offset: 8 }))
    expect(fs.readFileSync(local('live.jsonl'), 'utf8')).toBe('{"a":1}\n{"b":2}\n')
  })

  it('refetches a file the host truncated or rewrote, and drops one it removed', async () => {
    host.files.set('r.jsonl', Buffer.from('{"old":"long line"}\n'))
    host.files.set('gone.jsonl', Buffer.from('{}\n'))
    mirror.start()
    host.files.set('r.jsonl', Buffer.from('{"new":1}\n'))
    host.files.delete('gone.jsonl')
    host.push({ t: 'welcome' })
    expect(fs.readFileSync(local('r.jsonl'), 'utf8')).toBe('{"new":1}\n')
    expect(fs.existsSync(local('gone.jsonl'))).toBe(false)
  })

  it('fetches a missing blob so the image reads from the mirror', async () => {
    // 1x1 png
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    const hash = 'a'.repeat(64)
    host.blobs.set(hash, png)
    mirror.start()
    const dirs = blobAgentDirs(path.join(tmp, 'no-agent'), [remoteSessionsDir(tmp)])
    expect(() => readBlobImage(dirs, `blob:sha256:${hash}`)).toThrow()
    await mirror.blob(hash)
    expect(readBlobImage(dirs, `blob:sha256:${hash}`).width).toBe(1)
  })

  it('mirrors a subagent transcript named by its host path, then tails it', async () => {
    host.files.set('2026_abc.jsonl', Buffer.from('{}\n'))
    host.files.set('2026_abc/0-Scout.jsonl', Buffer.from('{"a":1}\n'))
    mirror.start()
    const hostPath =
      '/Users/ike/.omp/profiles/personal/agent/sessions/--Users-ike-Eva--/2026_abc/0-Scout.jsonl'
    const got = await mirror.openSubagent(hostPath)
    expect(got).toBe(local('2026_abc/0-Scout.jsonl'))
    expect(fs.readFileSync(got!, 'utf8')).toBe('{"a":1}\n')
    expect(host.sent).toContainEqual(
      expect.objectContaining({
        t: 'session.read',
        profile: 'personal',
        dir: '--Users-ike-Eva--',
        parent: '2026_abc',
      }),
    )
    const changed = vi.fn()
    mirror.onSubagentChange = changed
    host.files.set('2026_abc/0-Scout.jsonl', Buffer.from('{"a":1}\n{"b":2}\n'))
    host.push({ t: 'agents.delta' })
    vi.advanceTimersByTime(1000)
    expect(fs.readFileSync(got!, 'utf8')).toBe('{"a":1}\n{"b":2}\n')
    expect(changed).toHaveBeenCalled()
    // The chat's chip path (already in the mirror) resolves to the same file.
    expect(await mirror.openSubagent(got!)).toBe(got)
  })

  it('answers null for a subagent the host does not have', async () => {
    host.files.set('2026_abc.jsonl', Buffer.from('{}\n'))
    mirror.start()
    expect(await mirror.openSubagent('/h/agent/sessions/d/2026_abc/9-Nope.jsonl')).toBeNull()
  })
})
