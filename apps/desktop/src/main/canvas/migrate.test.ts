import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BoardNode } from '@relay/canvas-live/board'
import { boardText } from './board-text'
import { migrateLocalBoards } from './migrate'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const board = (title: string, nodes: BoardNode[] = []): string =>
  boardText({ version: 1, title, nodes, edges: [] })

function setup(hostBoards: Record<string, string> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-canvas-migrate-')))
  roots.push(root)
  const dir = path.join(root, 'canvases')
  const boards = new Map(Object.entries(hostBoards))
  const assets = new Map<string, Buffer>()
  const host = {
    list: async () => [...boards].map(([slug, text]) => ({ slug, text, modifiedMs: 1 })),
    write: async (slug: string, text: string, commit: () => void) => {
      commit()
      boards.set(slug, text)
    },
    writeAsset: async (src: string, bytes: Buffer) => {
      assets.set(src, bytes)
    },
  }
  const logs: string[] = []
  const run = () =>
    migrateLocalBoards({
      dir,
      host,
      hostname: 'Ikes-MacBook-Pro.local',
      today: new Date(2026, 10, 17, 9),
      log: (l) => logs.push(l),
    })
  return { root, dir, boards, assets, logs, run }
}

describe('migrating local boards to the host', () => {
  it('does nothing without a folder or boards in it', async () => {
    const { dir, run } = setup()
    expect((await run()).movedTo).toBeNull()
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    expect((await run()).movedTo).toBeNull()
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('uploads what the host lacks with its images, renames clashes, skips same or empty', async () => {
    const shared = board('Shared', [{ id: 'a', type: 'note', data: { title: 'hi' } }])
    const clash = board('Mine', [{ id: 'b', type: 'note', data: { title: 'mine' } }])
    const { root, dir, boards, assets, logs, run } = setup({
      shared,
      clash: board('Theirs', [{ id: 'c', type: 'note' }]),
      empty: board('Theirs too', [{ id: 'd', type: 'note' }]),
      // Uploaded on an earlier try that failed before the rename.
      'again-ikes-macbook-pro': board('Again', [{ id: 'e', type: 'note' }]),
      again: board('Theirs again', [{ id: 'f', type: 'note' }]),
    })
    fs.mkdirSync(path.join(dir, 'assets/pics'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'assets/pics/a.png'), 'png bytes')
    fs.writeFileSync(path.join(root, 'outside.png'), 'secret')
    const pics = board('Pictures', [
      { id: 'i1', type: 'image', data: { src: 'assets/pics/a.png' } },
      { id: 'i2', type: 'image', data: { src: 'https://example.com/x.png' } },
      { id: 'i3', type: 'image', data: { src: '../outside.png' } },
      { id: 'i4', type: 'image', data: { src: 'assets/pics/missing.png' } },
    ])
    fs.writeFileSync(path.join(dir, 'pics.json'), pics)
    fs.writeFileSync(path.join(dir, 'shared.json'), shared)
    fs.writeFileSync(path.join(dir, 'clash.json'), clash)
    fs.writeFileSync(path.join(dir, 'empty.json'), board('Nothing here'))
    fs.writeFileSync(path.join(dir, 'again.json'), board('Again', [{ id: 'e', type: 'note' }]))

    const result = await run()
    expect(result.uploaded).toEqual([
      { from: 'clash', to: 'clash-ikes-macbook-pro' },
      { from: 'pics', to: 'pics' },
    ])
    expect(result.skipped).toEqual(['again', 'empty', 'shared'])
    expect(boards.get('clash-ikes-macbook-pro')).toBe(clash)
    expect(boards.get('pics')).toBe(pics)
    expect([...assets.keys()]).toEqual(['assets/pics/a.png'])
    expect(assets.get('assets/pics/a.png')?.toString()).toBe('png bytes')
    const moved = path.join(root, 'canvases.migrated-2026-11-17')
    expect(result.movedTo).toBe(moved)
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.readFileSync(path.join(moved, 'clash.json'), 'utf8')).toBe(clash)
    expect(logs.join('\n')).toContain('uploaded clash as clash-ikes-macbook-pro')

    // Never again: the folder is gone; a new one the same day goes beside the first.
    expect((await run()).movedTo).toBeNull()
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'later.json'), board('Later', [{ id: 'l', type: 'note' }]))
    expect((await run()).movedTo).toBe(`${moved}-2`)
  })

  it('takes the next free name when the renamed one is taken by another board', async () => {
    const mine = board('Mine', [{ id: 'm', type: 'note' }])
    const { dir, run, boards } = setup({
      plan: board('Theirs', [{ id: 't', type: 'note' }]),
      'plan-ikes-macbook-pro': board('Other', [{ id: 'o', type: 'note' }]),
    })
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'plan.json'), mine)
    expect((await run()).uploaded).toEqual([{ from: 'plan', to: 'plan-ikes-macbook-pro-2' }])
    expect(boards.get('plan-ikes-macbook-pro-2')).toBe(mine)
  })

  it('keeps the folder when the host refuses a board, for the next connect', async () => {
    const { dir, run } = setup()
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'a.json'), board('A', [{ id: 'a', type: 'note' }]))
    const failing = migrateLocalBoards({
      dir,
      host: {
        list: async () => [],
        write: async () => {
          throw new Error('offline')
        },
        writeAsset: async () => undefined,
      },
      hostname: 'mac',
      today: new Date(),
      log: () => undefined,
    })
    await expect(failing).rejects.toThrow('offline')
    expect(fs.existsSync(dir)).toBe(true)
    expect((await run()).uploaded).toEqual([{ from: 'a', to: 'a' }])
  })
})
