import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RoomWorkdir, roomImagePath } from './workdir'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

async function room(): Promise<{ evaRoot: string; src: string; wd: RoomWorkdir }> {
  const evaRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workdir-')))
  dirs.push(evaRoot)
  const src = path.join(evaRoot, 'src')
  fs.mkdirSync(path.join(src, '.git'), { recursive: true })
  fs.writeFileSync(path.join(src, '.git/HEAD'), 'not ours')
  fs.writeFileSync(path.join(src, 'build.py'), 'a\n')
  fs.writeFileSync(path.join(evaRoot, 'ref.png'), 'ref')
  const wd = await RoomWorkdir.create({
    evaRoot,
    roomId: 'room-1',
    source: 'src',
    refs: ['ref.png', 'missing.png'],
  })
  return { evaRoot, src, wd }
}

describe('RoomWorkdir', () => {
  it('copies the source without its history, keeps renders untracked, and sync aborts a conflicting merge', async () => {
    const { src, wd } = await room()
    expect(wd.refs).toEqual([path.join(wd.root, 'refs/ref.png')])
    expect(fs.readFileSync(path.join(wd.main, 'build.py'), 'utf8')).toBe('a\n')
    expect((await wd.git(wd.main, ['log', '--format=%s'])).trim()).toBe(`Room source: ${src}`)
    const seat = await wd.addSeat('builder-1')
    fs.mkdirSync(path.join(seat, 'renders'))
    fs.writeFileSync(path.join(seat, 'renders/x.png'), 'x')
    fs.writeFileSync(path.join(seat, 'build.py'), 'seat\n')
    const h0 = await wd.head(seat)
    await wd.commit(seat, 'seat edit')
    expect(await wd.changed(seat, h0)).toEqual(['build.py'])
    fs.writeFileSync(path.join(wd.main, 'build.py'), 'main\n')
    await wd.commit(wd.main, 'main edit')
    expect(await wd.syncFromMain(seat)).toBe(false)
    expect(fs.readFileSync(path.join(seat, 'build.py'), 'utf8')).toBe('seat\n')
    expect((await wd.git(seat, ['status', '--porcelain'])).trim()).toBe('')
    // The source was never touched.
    expect(fs.readFileSync(path.join(src, 'build.py'), 'utf8')).toBe('a\n')
  })

  it('room images are only files inside the workdir or its refs', async () => {
    const { evaRoot, wd } = await room()
    const inside = path.join(wd.refsDir, 'ref.png')
    expect(roomImagePath(wd.root, wd.refs, inside)).toBe(inside)
    for (const p of [
      path.join(evaRoot, 'ref.png'),
      path.join(wd.main, 'build.py'),
      'refs/ref.png',
      `${wd.root}/../ref.png`,
    ]) {
      expect(() => roomImagePath(wd.root, wd.refs, p), p).toThrow(
        expect.objectContaining({ code: 'bad-path' }),
      )
    }
    fs.symlinkSync(path.join(evaRoot, 'ref.png'), path.join(wd.root, 'escape.png'))
    expect(() => roomImagePath(wd.root, wd.refs, path.join(wd.root, 'escape.png'))).toThrow()
  })
})
