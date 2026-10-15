import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openPathChecked } from './open-path'

describe('openPathChecked', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-op-'))
  const root = path.join(base, 'root')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'a.md'), 'x')
  fs.writeFileSync(path.join(outside, 'b.md'), 'x')
  fs.symlinkSync(path.join(outside, 'b.md'), path.join(root, 'link.md'))
  fs.mkdirSync(path.join(root, 'dir'))
  const ctx = (e2e: boolean) => ({ env: { evaRoot: root, e2e } }) as never
  const ok = async () => ''

  it('refuses outside, symlink escape, directory and missing', async () => {
    for (const p of [
      path.join(outside, 'b.md'),
      path.join(root, 'link.md'),
      path.join(root, 'dir'),
      path.join(root, 'zzz.md'),
    ]) {
      await expect(openPathChecked(ctx(false), p, { opener: ok })).rejects.toMatchObject({
        code: 'open-failed',
      })
    }
  })

  it('opens an allowed file and surfaces opener errors with the path', async () => {
    const seen: string[] = []
    await openPathChecked(ctx(false), path.join(root, 'a.md'), {
      opener: async (p) => (seen.push(p), ''),
    })
    expect(seen).toHaveLength(1)
    const p = path.join(root, 'a.md')
    await expect(openPathChecked(ctx(false), p, { opener: async () => 'boom' })).rejects.toThrow(p)
  })

  it('records instead of opening in e2e', async () => {
    let called = false
    await openPathChecked(ctx(true), path.join(root, 'a.md'), {
      opener: async () => ((called = true), ''),
    })
    expect(called).toBe(false)
  })
})
