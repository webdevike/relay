import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { matchWrite } from './allowlist'
import { createEvaFs, EvaFsDenied } from './eva-fs'
import { createPathQueue } from './path-queue'
import { installWriteTrap } from './write-trap'

let root: string
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evafs-')))
  fs.mkdirSync(path.join(root, 'memory'))
  fs.writeFileSync(path.join(root, 'memory/todos.md'), '# T\n')
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('allowlist per kind', () => {
  it('todo-append only accepts memory/todos.md', () => {
    expect(matchWrite('todo-append', root, 'memory/todos.md').ok).toBe(true)
    expect(matchWrite('todo-append', root, 'memory/journal.md').ok).toBe(false)
  })
  it('job-md accepts jobs/<name>/job.md only', () => {
    expect(matchWrite('job-md', root, 'jobs/daily-digest/job.md').ok).toBe(true)
    expect(matchWrite('job-md', root, 'jobs/Bad Name/job.md').ok).toBe(false)
    expect(matchWrite('job-md', root, 'jobs/x/other.md').ok).toBe(false)
    expect(matchWrite('job-md', root, 'jobs/x/y/job.md').ok).toBe(false)
  })
  it('job-delete accepts jobs/<name> only', () => {
    expect(matchWrite('job-delete', root, 'jobs/daily').ok).toBe(true)
    expect(matchWrite('job-delete', root, 'jobs').ok).toBe(false)
    expect(matchWrite('job-delete', root, 'memory').ok).toBe(false)
  })
  it('meeting-status accepts work/meetings/<stem>.json only', () => {
    expect(matchWrite('meeting-status', root, 'work/meetings/2026-10-01-sync.json').ok).toBe(true)
    expect(matchWrite('meeting-status', root, 'work/meetings/x.md').ok).toBe(false)
    expect(matchWrite('meeting-status', root, 'work/other/x.json').ok).toBe(false)
  })
  it('file-save accepts files inside the root', () => {
    expect(matchWrite('file-save', root, 'notes/a.txt').ok).toBe(true)
  })
  it('unknown kind throws EvaFsDenied', async () => {
    const evafs = createEvaFs({ root })
    await expect(evafs.write('bogus' as never, 'memory/todos.md', 'x')).rejects.toBeInstanceOf(
      EvaFsDenied,
    )
  })
})

describe('traversal and symlink escape', () => {
  it('rejects absolute paths and .. segments for every kind', () => {
    for (const kind of ['todo-append', 'file-save', 'job-md', 'job-delete', 'meeting-status']) {
      expect(matchWrite(kind, root, '/etc/passwd').ok, kind).toBe(false)
      expect(matchWrite(kind, root, '../x').ok, kind).toBe(false)
      expect(matchWrite(kind, root, 'memory/../../x').ok, kind).toBe(false)
    }
  })
  it('rejects a path that escapes through a symlink', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evafs-out-')))
    try {
      fs.symlinkSync(outside, path.join(root, 'link'))
      const r = matchWrite('file-save', root, 'link/new.txt')
      expect(r.ok).toBe(false)
      fs.symlinkSync(outside, path.join(root, 'jobs'))
      expect(matchWrite('job-md', root, 'jobs/x/job.md').ok).toBe(false)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
  it('rejects file-save onto a symlink', () => {
    fs.symlinkSync(path.join(root, 'memory/todos.md'), path.join(root, 'alias.md'))
    expect(matchWrite('file-save', root, 'alias.md').ok).toBe(false)
  })
})

describe('EvaFs write and remove', () => {
  it('writes atomically through the allowlist and leaves no temp file', async () => {
    const evafs = createEvaFs({ root })
    await evafs.write('job-md', 'jobs/daily/job.md', 'hello')
    expect(fs.readFileSync(path.join(root, 'jobs/daily/job.md'), 'utf8')).toBe('hello')
    expect(fs.readdirSync(path.join(root, 'jobs/daily'))).toEqual(['job.md'])
    await evafs.remove('job-delete', 'jobs/daily')
    expect(fs.existsSync(path.join(root, 'jobs/daily'))).toBe(false)
  })
  it('throws EvaFsDenied with kind, path and reason', async () => {
    const evafs = createEvaFs({ root })
    const err = await evafs.write('todo-append', 'memory/journal.md', 'x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EvaFsDenied)
    expect(err).toMatchObject({ kind: 'todo-append', path: 'memory/journal.md' })
  })
})

describe('EvaFs readStamp, edit, create', () => {
  const todos = (): string => path.join(root, 'memory/todos.md')

  it('readStamp returns text, stat and sha256; null when missing; denies bad path', async () => {
    const evafs = createEvaFs({ root })
    const s = await evafs.readStamp('todo-append', 'memory/todos.md')
    expect(s?.text).toBe('# T\n')
    expect(s?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(s?.size).toBe(4)
    expect(typeof s?.mtimeMs).toBe('number')
    expect(await evafs.readStamp('job-md', 'jobs/none/job.md')).toBeNull()
    await expect(evafs.readStamp('todo-append', 'memory/journal.md')).rejects.toBeInstanceOf(
      EvaFsDenied,
    )
  })

  it('edit applies the transform atomically; no-op writes nothing', async () => {
    const evafs = createEvaFs({ root })
    const r = await evafs.edit('todo-append', 'memory/todos.md', (t) => t + 'a\n')
    expect(r).toEqual({ before: '# T\n', after: '# T\na\n', changed: true })
    expect(fs.readdirSync(path.join(root, 'memory'))).toEqual(['todos.md'])
    const m = fs.statSync(todos()).mtimeMs
    expect((await evafs.edit('todo-append', 'memory/todos.md', (t) => t)).changed).toBe(false)
    expect((await evafs.edit('todo-append', 'memory/todos.md', () => null)).changed).toBe(false)
    expect(fs.statSync(todos()).mtimeMs).toBe(m)
  })

  it('edit with a stale expected basis refuses with changed-on-disk', async () => {
    const evafs = createEvaFs({ root })
    const err = await evafs
      .edit('todo-append', 'memory/todos.md', (t) => t + 'x', { expected: 'old' })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'changed-on-disk' })
    expect(fs.readFileSync(todos(), 'utf8')).toBe('# T\n')
  })

  it('edit refuses when the file changes mid-edit; retryOnChange retries once', async () => {
    const evafs = createEvaFs({ root })
    let fired = false
    const sneaky = (t: string): string => {
      if (!fired) {
        fired = true
        fs.writeFileSync(todos(), '# T\nexternal\n')
      }
      return t + 'mine\n'
    }
    await expect(evafs.edit('todo-append', 'memory/todos.md', sneaky)).rejects.toMatchObject({
      code: 'changed-on-disk',
    })
    expect(fs.readFileSync(todos(), 'utf8')).toBe('# T\nexternal\n')

    fired = false
    fs.writeFileSync(todos(), '# T\n')
    let calls = 0
    const r = await evafs.edit(
      'todo-append',
      'memory/todos.md',
      (t) => {
        calls++
        return sneaky(t)
      },
      { retryOnChange: true },
    )
    expect(calls).toBe(2)
    expect(r.changed).toBe(true)
    expect(fs.readFileSync(todos(), 'utf8')).toBe('# T\nexternal\nmine\n')
  })

  it('edit on a missing file throws not-found', async () => {
    const evafs = createEvaFs({ root })
    await expect(evafs.edit('job-md', 'jobs/none/job.md', (t) => t)).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('concurrent edits on one path serialize; createPathQueue semantics', async () => {
    const evafs = createEvaFs({ root })
    await Promise.all([
      evafs.edit('todo-append', 'memory/todos.md', (t) => t + 'one\n'),
      evafs.edit('todo-append', 'memory/todos.md', (t) => t + 'two\n'),
    ])
    expect(fs.readFileSync(todos(), 'utf8')).toBe('# T\none\ntwo\n')

    const q = createPathQueue()
    const order: string[] = []
    const gate = new Promise<void>((r) => setTimeout(r, 20))
    const a = q.run('k', async () => {
      await gate
      order.push('a')
    })
    const b = q.run('k', async () => {
      order.push('b')
    })
    const c = q.run('other', async () => {
      order.push('c')
    })
    await Promise.all([a, b, c])
    expect(order).toEqual(['c', 'a', 'b'])
    await expect(q.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await q.run('k', async () => 7)).toBe(7)
  })

  it('create makes jobs/<name>/job.md and refuses an existing one', async () => {
    const evafs = createEvaFs({ root })
    await evafs.create('job-md', 'jobs/new-job/job.md', 'data')
    expect(fs.readFileSync(path.join(root, 'jobs/new-job/job.md'), 'utf8')).toBe('data')
    await expect(evafs.create('job-md', 'jobs/new-job/job.md', 'x')).rejects.toMatchObject({
      code: 'already-exists',
    })
    await expect(
      evafs.create('todo-append' as never, 'memory/todos.md', 'x'),
    ).rejects.toBeInstanceOf(EvaFsDenied)
  })

  it('edit and create satisfy the runtime write trap', async () => {
    const uninstall = installWriteTrap({ protectedRoots: [root], allowRoots: [] })
    try {
      const evafs = createEvaFs({ root })
      await evafs.edit('todo-append', 'memory/todos.md', (t) => t + 'z\n')
      await evafs.create('job-md', 'jobs/trap-job/job.md', 'd')
      expect(() => fs.writeFileSync(path.join(root, 'raw.txt'), 'x')).toThrow()
    } finally {
      uninstall()
    }
  })
})
