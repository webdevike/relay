import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayFrames } from '../relay/client'
import { createHostAgentFiles, OLD_HOST_FILES } from '../relay/host-agent-files'
import {
  createAgentFiles,
  HOST_ROOT_PREFIX,
  isHostRoot,
  localAgentFiles,
  POLL_MS,
} from './agent-files'

type Frame = Record<string, unknown>

/** A Relay Host that holds nova's two files in memory and answers `assistant.file.req` like the real one. */
class FakeHost implements RelayFrames {
  files: Record<string, string> = { prime: 'You are Nova.\n', thread: '# Thread\n' }
  up = true
  answering = true
  requests: Frame[] = []
  private cbs = new Set<(f: Frame) => void>()
  onFrame(cb: (f: Frame) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  private version(file: string) {
    const text = this.files[file] ?? ''
    return { mtimeMs: 1, size: text.length, hash: `h:${text}` }
  }
  sendFrame(f: Frame): boolean {
    if (!this.up) return false
    this.requests.push(f)
    if (!this.answering) return true
    const file = String(f.file)
    let res: Frame
    if (f.agent !== 'nova') res = { ok: false, code: 'unknown-agent', error: 'ghost is not here.' }
    else if (f.op === 'save') {
      if (f.force !== true && f.expectedHash !== this.version(file).hash)
        res = { ok: false, code: 'changed-on-disk', error: 'The file changed on the host.' }
      else {
        this.files[file] = String(f.text)
        res = { ok: true, path: `/Users/mini/Eva/${file}.md`, version: this.version(file) }
      }
    } else if (f.op === 'version') {
      res = { ok: true, path: `/Users/mini/Eva/${file}.md`, version: this.version(file) }
    } else {
      res = {
        ok: true,
        kind: 'text',
        text: this.files[file],
        path: `/Users/mini/Eva/${file}.md`,
        version: this.version(file),
      }
    }
    queueMicrotask(() => {
      for (const cb of [...this.cbs]) cb({ t: 'assistant.file.res', rid: f.rid, ...res })
    })
    return true
  }
}

let host: FakeHost
let changed: [string, string[]][]
beforeEach(() => {
  host = new FakeHost()
  changed = []
})
afterEach(() => vi.useRealTimers())

const service = (pollMs?: number) =>
  createAgentFiles({
    host: createHostAgentFiles(host, 200),
    emitChanged: (root, paths) => changed.push([root, paths]),
    pollMs,
  })

describe('assistant instruction files through the Mini host', () => {
  it('opens a virtual root per assistant that lists just prime.md and thread.md', () => {
    const files = service()
    const o = files.open('nova')
    expect(o).toEqual({
      root: `${HOST_ROOT_PREFIX}nova`,
      name: 'nova instructions',
      prime: 'prime.md',
      thread: 'thread.md',
      remote: true,
    })
    expect(isHostRoot(o.root)).toBe(true)
    expect(isHostRoot('/Users/ike/Eva')).toBe(false)
    expect(files.list(o.root, '').entries.map((e) => [e.path, e.kind])).toEqual([
      ['prime.md', 'file'],
      ['thread.md', 'file'],
    ])
    expect(() => files.list(o.root, 'sub')).toThrow(/not a folder/)
  })

  it('reads through the host and reports versions, binary and too-large as the Files panel does', async () => {
    const files = service()
    const { root } = files.open('nova')
    expect(await files.read(root, 'prime.md')).toEqual({
      kind: 'text',
      text: 'You are Nova.\n',
      version: { mtimeMs: 1, size: 14, hash: 'h:You are Nova.\n' },
    })
    expect(host.requests[0]).toMatchObject({
      t: 'assistant.file.req',
      op: 'read',
      agent: 'nova',
      file: 'prime',
    })
    expect(files.hostPathOf(root, 'prime.md')).toBe('/Users/mini/Eva/prime.md')
    expect(files.hostPathOf(root, 'thread.md')).toBeNull()
  })

  it('reaches nothing but the two files of roots it opened', async () => {
    const files = service()
    const { root } = files.open('nova')
    await expect(files.read(root, '../prime.md')).rejects.toMatchObject({ code: 'not-found' })
    await expect(files.read(root, '.omp/assistant/agents/nova/prime.md')).rejects.toMatchObject({
      code: 'not-found',
    })
    await expect(files.read(`${HOST_ROOT_PREFIX}astra`, 'prime.md')).rejects.toMatchObject({
      code: 'unknown-root',
    })
    await expect(
      files.save({ root: '/', path: 'prime.md', text: 'x', expected: null, force: true }),
    ).rejects.toMatchObject({ code: 'unknown-root' })
    expect(host.requests).toHaveLength(0)
  })

  it('saves with the expected hash and keeps the host answer in sync', async () => {
    const files = service()
    const { root } = files.open('nova')
    const read = await files.read(root, 'prime.md')
    if (read.kind !== 'text') throw new Error('text expected')
    const saved = await files.save({
      root,
      path: 'prime.md',
      text: 'You are Nova, shorter.\n',
      expected: read.version,
      force: false,
    })
    expect(host.files['prime']).toBe('You are Nova, shorter.\n')
    expect(host.requests.at(-1)).toMatchObject({ op: 'save', expectedHash: read.version.hash })
    expect(saved.version.hash).toBe('h:You are Nova, shorter.\n')
  })

  it('a save over a changed host file fails changed-on-disk, and force writes over it', async () => {
    const files = service()
    const { root } = files.open('nova')
    const read = await files.read(root, 'prime.md')
    if (read.kind !== 'text') throw new Error('text expected')
    host.files['prime'] = 'edited on the Mini\n'
    const mine = { root, path: 'prime.md', text: 'mine', expected: read.version }
    await expect(files.save({ ...mine, force: false })).rejects.toMatchObject({
      code: 'changed-on-disk',
    })
    expect(host.files['prime']).toBe('edited on the Mini\n')
    await files.save({ ...mine, force: true })
    expect(host.files['prime']).toBe('mine')
  })

  it('tells when the host is not connected or does not answer', async () => {
    const files = service()
    const { root } = files.open('nova')
    host.up = false
    await expect(files.read(root, 'prime.md')).rejects.toMatchObject({
      code: 'host-unavailable',
      message: "Relay isn't connected.",
    })
    host.up = true
    host.answering = false
    vi.useFakeTimers()
    const p = files.read(root, 'prime.md')
    const settled = expect(p).rejects.toMatchObject({ message: OLD_HOST_FILES })
    await vi.advanceTimersByTimeAsync(300)
    await settled
  })

  it('polls watched files and reports a change made on the Mini, but not its own save', async () => {
    vi.useFakeTimers()
    const files = service()
    const { root } = files.open('nova')
    const read = await files.read(root, 'prime.md')
    if (read.kind !== 'text') throw new Error('text expected')
    files.watch(root, ['', 'prime.md', 'thread.md'])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(changed).toEqual([])
    // The first poll learned thread.md's version (it was never read); now it changes on the Mini.
    host.files['thread'] = '# Thread\nedited\n'
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(changed).toEqual([[root, ['thread.md']]])
    changed.length = 0
    await files.save({ root, path: 'prime.md', text: 'x', expected: read.version, force: false })
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(changed).toEqual([])
    host.files['prime'] = 'edited on the Mini\n'
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(changed).toEqual([[root, ['prime.md']]])
    // Watching another root stops the polling.
    files.watch('', [])
    host.requests.length = 0
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    expect(host.requests).toHaveLength(0)
    files.close()
  })
})

describe('localAgentFiles', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })
  const home = (eva: boolean): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agentfiles-'))
    dirs.push(d)
    fs.mkdirSync(path.join(d, 'work', ...(eva ? ['eva'] : []), 'agents'), { recursive: true })
    return d
  }

  it('finds thread.md where Eva keeps it, or in a starter home', () => {
    expect(localAgentFiles(home(true), 'nova')).toEqual({
      prime: '.omp/assistant/agents/nova/prime.md',
      thread: 'work/eva/agents/nova/thread.md',
    })
    expect(localAgentFiles(home(false), 'nova')).toEqual({
      prime: '.omp/assistant/agents/nova/prime.md',
      thread: 'work/agents/nova/thread.md',
    })
  })
})
