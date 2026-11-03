import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createConfigStore } from '../config-store'
import { folderSections, guideCache, parseGuide, promptDiff } from './guide'

const PATHS = ['src/a/policy.ts', 'src/a/route.ts', 'tests/a.test.ts', 'README.md']

describe('reviews guide', () => {
  it('keeps the model sections over exactly the PR files', () => {
    const text = `Here it is: {"sections":[
      {"title":"Policy","why":"Edits lock at 30 minutes.","files":["src/a/policy.ts","nope.ts"]},
      {"title":"Endpoint","files":["src/a/route.ts","src/a/policy.ts"]},
      {"title":"Empty","why":"x","files":["ghost.ts"]},
      {"why":"no title","files":["README.md"]}
    ]}`
    expect(parseGuide(text, PATHS)).toEqual([
      { title: 'Policy', why: 'Edits lock at 30 minutes.', files: ['src/a/policy.ts'] },
      { title: 'Endpoint', why: '', files: ['src/a/route.ts'] },
      { title: 'Other changes', why: '', files: ['tests/a.test.ts', 'README.md'] },
    ])
    expect(parseGuide('no json here', PATHS)).toBeNull()
    expect(parseGuide('{"sections":[{"title":"x","files":["ghost.ts"]}]}', PATHS)).toBeNull()
  })

  it('falls back to folders, source first', () => {
    expect(folderSections(PATHS).map((s) => [s.title, s.files])).toEqual([
      ['src/a', ['src/a/policy.ts', 'src/a/route.ts']],
      ['tests', ['tests/a.test.ts']],
      ['Top-level files', ['README.md']],
    ])
  })

  it('cuts a long file diff', () => {
    const big = `diff --git a/x b/x\n${'+y\n'.repeat(10_000)}diff --git a/z b/z\n+z\n`
    const out = promptDiff(big)
    expect(out).toContain("[... rest of this file's diff cut]")
    expect(out).toContain('diff --git a/z b/z')
  })

  it('writes once per head, keeps only written guides, and falls back on failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'))
    const config = createConfigStore(dir)
    const input = {
      title: 't',
      body: '',
      diff: '',
      files: PATHS.map((p) => ({ path: p, additions: 1, deletions: 0 })),
    }
    const write = vi.fn(
      async () => '{"sections":[{"title":"All","why":"w","files":["src/a/policy.ts"]}]}',
    )
    const read = guideCache(config, write)
    const [a, b] = await Promise.all([read('o/r#1', 'sha1', input), read('o/r#1', 'sha1', input)])
    expect(a).toEqual(b)
    expect(a.source).toBe('model')
    expect((await read('o/r#1', 'sha1', input)).sections[0]!.title).toBe('All')
    expect(write).toHaveBeenCalledTimes(1)

    const failing = guideCache(config, async () => {
      throw new Error('Claude took too long')
    })
    const fb = await failing('o/r#1', 'sha2', input)
    expect(fb).toMatchObject({ source: 'folders', error: 'Claude took too long' })
    expect(
      Object.keys(config.readJson<Record<string, unknown>>('reviews-guides.json', {})),
    ).toEqual(['o/r#1@sha1'])
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
