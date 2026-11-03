import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFilesWatch, type FilesWatch } from './files-watch'

let root: string
let watch: FilesWatch
let sent: string[][]

// Real file system events run on the platform clock: chokidar exposes no per-root ready signal
// here and a negative check has no event to await, so these tests wait briefly for real.
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-files-')))
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')
  fs.mkdirSync(path.join(root, 'sub'))
  sent = []
  watch = createFilesWatch((r, paths) => r === root && sent.push(paths), { debounceMs: 50 })
})

afterEach(async () => {
  await watch.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('createFilesWatch', () => {
  it('reports a folder listing change, a file content change, never save temps', async () => {
    watch.set(root, [
      { rel: '', real: root },
      { rel: 'a.txt', real: path.join(root, 'a.txt') },
    ])
    // Let chokidar finish its initial scan, as canvas/watch.test.ts does.
    await sleep(400)
    fs.writeFileSync(path.join(root, '.a.txt.123.abc.tmp'), 'temp')
    fs.writeFileSync(path.join(root, 'b.txt'), 'b')
    await vi.waitFor(() => expect(sent.flat()).toContain('b.txt'), { timeout: 3000 })
    expect(sent.flat()).toContain('')
    expect(sent.flat().some((p) => p.endsWith('.tmp'))).toBe(false)
    sent = []
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed')
    await vi.waitFor(() => expect(sent.flat()).toContain('a.txt'), { timeout: 3000 })
  })

  it('stops reporting once the set is empty', async () => {
    watch.set(root, [{ rel: 'sub', real: path.join(root, 'sub') }])
    await sleep(400)
    watch.set(root, [])
    fs.writeFileSync(path.join(root, 'sub/c.txt'), 'c')
    await sleep(400)
    expect(sent).toEqual([])
  })
})
