import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { matchWrite } from './allowlist'
import { createEvaFs, EvaFsDenied } from './eva-fs'

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
