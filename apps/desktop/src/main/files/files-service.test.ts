import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Place } from '@evaos/chat-core/work'
import { createFilesService, type FilesService } from './files-service'

let base: string
let root: string
let outside: string
let service: FilesService
let place: Place | null

const put = (rel: string, data: string | Buffer, dir = root): string => {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, data)
  return abs
}

const sha1 = (data: string | Buffer): string => createHash('sha1').update(data).digest('hex')

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-files-')))
  root = path.join(base, 'root')
  outside = path.join(base, 'outside')
  put('a.txt', 'alpha\n')
  put('sub/b.txt', 'bravo\n')
  put('.git/HEAD', 'ref: refs/heads/main\n')
  put('secrets/key', 'hunter2\n')
  put('x.txt', 'secret outside\n', outside)
  fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'link-in'))
  fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link-file-in'))
  fs.symlinkSync(outside, path.join(root, 'link-out'))
  fs.symlinkSync(path.join(outside, 'x.txt'), path.join(root, 'link-out-file'))
  fs.symlinkSync(path.join(base, 'missing'), path.join(root, 'broken'))
  place = null
  service = createFilesService({
    evaRoot: root,
    placeOf: () => place,
    env: () => Promise.resolve(process.env),
    rgPath: () => Promise.resolve(null),
    emitChanged: () => undefined,
  })
  await service.root(null)
})

afterEach(async () => {
  await service.close()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('roots', () => {
  it('resolves the Eva root, a chat worktree, else its cwd', async () => {
    expect(await service.root(null)).toEqual({ root, name: 'root' })
    const cwd = path.join(root, 'sub')
    const wt = fs.mkdtempSync(path.join(base, 'wt-'))
    place = { cwd, active: wt, activeBranch: null, cwdBranch: null, eva: false }
    expect((await service.root('/sessions/s.jsonl')).root).toBe(wt)
    const gone = path.join(base, 'gone')
    place = { cwd, active: gone, activeBranch: null, cwdBranch: null, eva: false }
    expect((await service.root('/sessions/s.jsonl')).root).toBe(cwd)
    place = { cwd: gone, active: null, activeBranch: null, cwdBranch: null, eva: false }
    expect((await service.root('/sessions/s.jsonl')).root).toBe(root)
  })

  it('rejects a root main never handed out', async () => {
    await expect(service.list(outside, '')).rejects.toMatchObject({ code: 'unknown-root' })
    await expect(service.read(path.join(base, 'nope'), 'a.txt')).rejects.toMatchObject({
      code: 'unknown-root',
    })
    await expect(service.gitStatus(outside)).rejects.toMatchObject({ code: 'unknown-root' })
    await expect(service.watch(outside, [''])).rejects.toMatchObject({ code: 'unknown-root' })
  })
})

describe('list', () => {
  it('lists folders first, hides .git, locks secrets and escaping or broken links', async () => {
    const { entries } = await service.list(root, '')
    expect(entries.map((e) => e.name)).toEqual([
      'link-in',
      'link-out',
      'secrets',
      'sub',
      'a.txt',
      'broken',
      'link-file-in',
      'link-out-file',
    ])
    const by = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(by['link-in']).toMatchObject({ kind: 'dir', symlink: true, locked: false })
    expect(by['link-out']).toMatchObject({ kind: 'dir', symlink: true, locked: true })
    expect(by['link-out-file']).toMatchObject({ kind: 'file', symlink: true, locked: true })
    expect(by['broken']).toMatchObject({ symlink: true, locked: true })
    expect(by['secrets']).toMatchObject({ kind: 'dir', locked: true })
    expect(by['a.txt']).toEqual({
      name: 'a.txt',
      path: 'a.txt',
      kind: 'file',
      symlink: false,
      locked: false,
    })
    const sub = await service.list(root, 'link-in')
    expect(sub.entries.map((e) => e.path)).toEqual(['link-in/b.txt'])
  })

  it('sorts case-insensitively with numbers by value', async () => {
    for (const n of ['file10', 'File2', 'file1']) put(`n/${n}`, '')
    const { entries } = await service.list(root, 'n')
    expect(entries.map((e) => e.name)).toEqual(['file1', 'File2', 'file10'])
  })
})

describe('path safety', () => {
  it('refuses .., absolute paths and links that leave the root', async () => {
    for (const p of ['../outside/x.txt', 'sub/../../outside/x.txt', '/etc/hosts']) {
      await expect(service.read(root, p)).rejects.toMatchObject({ code: 'outside-root' })
    }
    await expect(service.read(root, 'link-out-file')).rejects.toMatchObject({
      code: 'outside-root',
    })
    await expect(service.read(root, 'link-out/x.txt')).rejects.toMatchObject({
      code: 'outside-root',
    })
    await expect(service.list(root, 'link-out')).rejects.toMatchObject({ code: 'outside-root' })
    await expect(service.read(root, 'a\0b')).rejects.toMatchObject({ code: 'invalid-path' })
  })

  it('follows links that stay inside the root', async () => {
    const linked = await service.read(root, 'link-in/b.txt')
    expect(linked).toMatchObject({ kind: 'text', text: 'bravo\n' })
    const file = await service.read(root, 'link-file-in')
    expect(file).toMatchObject({ kind: 'text', text: 'alpha\n' })
  })

  it('locks .git and secrets', async () => {
    await expect(service.read(root, '.git/HEAD')).rejects.toMatchObject({ code: 'locked' })
    await expect(service.list(root, '.git')).rejects.toMatchObject({ code: 'locked' })
    await expect(service.read(root, 'secrets/key')).rejects.toMatchObject({ code: 'locked' })
    await expect(service.list(root, 'secrets')).rejects.toMatchObject({ code: 'locked' })
    fs.symlinkSync(path.join(root, 'secrets/key'), path.join(root, 'sneaky'))
    await expect(service.read(root, 'sneaky')).rejects.toMatchObject({ code: 'locked' })
  })
})

describe('read', () => {
  it('reads text with its version', async () => {
    const st = fs.statSync(path.join(root, 'a.txt'))
    expect(await service.read(root, 'a.txt')).toEqual({
      kind: 'text',
      text: 'alpha\n',
      version: { mtimeMs: st.mtimeMs, size: 6, hash: sha1('alpha\n') },
    })
    put('pic.svg', '<svg/>')
    expect(await service.read(root, 'pic.svg')).toMatchObject({ kind: 'text', text: '<svg/>' })
  })

  it('tells binary, too-large and images apart', async () => {
    put('nul.bin', Buffer.from([0x61, 0x00, 0x62]))
    expect(await service.read(root, 'nul.bin')).toEqual({ kind: 'binary', size: 3 })
    put('bad.txt', Buffer.from([0x61, 0xff, 0xfe]))
    expect(await service.read(root, 'bad.txt')).toEqual({ kind: 'binary', size: 3 })
    const big = put('big.txt', '')
    fs.truncateSync(big, 5 * 1024 * 1024 + 1)
    const size = 5 * 1024 * 1024 + 1
    expect(await service.read(root, 'big.txt')).toEqual({ kind: 'too-large', size })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    put('dot.PNG', png)
    expect(await service.read(root, 'dot.PNG')).toEqual({
      kind: 'image',
      mime: 'image/png',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      size: 8,
    })
  })
})

describe('save', () => {
  const textOf = async (rel: string) => {
    const c = await service.read(root, rel)
    if (c.kind !== 'text') throw new Error(`not text: ${c.kind}`)
    return c
  }

  it('replaces the content atomically and keeps the mode', async () => {
    const abs = put('doc.md', 'one\n')
    fs.chmodSync(abs, 0o640)
    const { version } = await textOf('doc.md')
    const saved = await service.save({
      root,
      path: 'doc.md',
      text: 'two\n',
      expected: version,
      force: false,
    })
    expect(fs.readFileSync(abs, 'utf8')).toBe('two\n')
    expect(fs.statSync(abs).mode & 0o777).toBe(0o640)
    expect(saved.version).toMatchObject({ size: 4, hash: sha1('two\n') })
    expect(fs.readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([])
    // The returned version is good for the next save.
    const next = { root, path: 'doc.md', text: 'three\n', expected: saved.version, force: false }
    await service.save(next)
    expect(fs.readFileSync(abs, 'utf8')).toBe('three\n')
  })

  it('refuses when the disk changed, unless forced', async () => {
    const abs = put('doc.md', 'one\n')
    const { version } = await textOf('doc.md')
    fs.writeFileSync(abs, 'theirs\n')
    await expect(
      service.save({ root, path: 'doc.md', text: 'mine\n', expected: version, force: false }),
    ).rejects.toMatchObject({ code: 'changed-on-disk' })
    expect(fs.readFileSync(abs, 'utf8')).toBe('theirs\n')
    await expect(
      service.save({ root, path: 'doc.md', text: 'mine\n', expected: null, force: false }),
    ).rejects.toMatchObject({ code: 'changed-on-disk' })
    await service.save({ root, path: 'doc.md', text: 'mine\n', expected: version, force: true })
    expect(fs.readFileSync(abs, 'utf8')).toBe('mine\n')
  })

  it('never creates a file or writes outside the root', async () => {
    await expect(
      service.save({ root, path: 'new.txt', text: 'x', expected: null, force: true }),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false)
    await expect(
      service.save({ root, path: 'link-out-file', text: 'x', expected: null, force: true }),
    ).rejects.toMatchObject({ code: 'outside-root' })
    await expect(
      service.save({ root, path: '../outside/x.txt', text: 'x', expected: null, force: true }),
    ).rejects.toMatchObject({ code: 'outside-root' })
    expect(fs.readFileSync(path.join(outside, 'x.txt'), 'utf8')).toBe('secret outside\n')
    await expect(
      service.save({ root, path: 'sub', text: 'x', expected: null, force: true }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('saves through a link inside the root and keeps the link', async () => {
    await service.save({ root, path: 'link-file-in', text: 'link\n', expected: null, force: true })
    expect(fs.lstatSync(path.join(root, 'link-file-in')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('link\n')
  })

  it('serializes saves to one file', async () => {
    const abs = put('doc.md', 'one\n')
    await Promise.all(
      ['a', 'b', 'c'].map((t) =>
        service.save({ root, path: 'doc.md', text: t, expected: null, force: true }),
      ),
    )
    expect(fs.readFileSync(abs, 'utf8')).toBe('c')
    expect(fs.readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})
