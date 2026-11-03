import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEvaFs } from './eva-fs'
import { installWriteTrap } from './write-trap'

let base: string
let P: string
let A: string
let outside: string
let uninstall: () => void
const hits: string[] = []

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trap-')))
  P = path.join(base, 'protected')
  A = path.join(P, 'allowed')
  outside = path.join(base, 'outside')
  fs.mkdirSync(A, { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(P, 'existing.txt'), 'x')
  hits.length = 0
  uninstall = installWriteTrap({
    protectedRoots: [P],
    allowRoots: [A],
    onBlock: (p) => hits.push(p),
  })
})
afterEach(() => {
  uninstall()
  fs.rmSync(base, { recursive: true, force: true })
})

const trap = { code: 'EVAOS_WRITE_TRAP' }

describe('write trap', () => {
  it('blocks sync write APIs under the protected root', () => {
    expect(() => fs.writeFileSync(path.join(P, 'x'), 'a')).toThrow(expect.objectContaining(trap))
    expect(() => fs.appendFileSync(path.join(P, 'x'), 'a')).toThrow(expect.objectContaining(trap))
    expect(() => fs.renameSync(path.join(outside, 'nope'), path.join(P, 'y'))).toThrow(
      expect.objectContaining(trap),
    )
    expect(() => fs.rmSync(path.join(P, 'existing.txt'))).toThrow(expect.objectContaining(trap))
    expect(() => fs.unlinkSync(path.join(P, 'existing.txt'))).toThrow(expect.objectContaining(trap))
    expect(() => fs.mkdirSync(path.join(P, 'd'))).toThrow(expect.objectContaining(trap))
    expect(() => fs.copyFileSync(path.join(P, 'existing.txt'), path.join(P, 'copy'))).toThrow(
      expect.objectContaining(trap),
    )
    expect(() => fs.openSync(path.join(P, 'o'), 'w')).toThrow(expect.objectContaining(trap))
    expect(() => fs.createWriteStream(path.join(P, 's'))).toThrow(expect.objectContaining(trap))
    expect(fs.existsSync(path.join(P, 'x'))).toBe(false)
    expect(hits.length).toBeGreaterThan(5)
  })

  it('blocks promise and callback write APIs', async () => {
    await expect(fs.promises.writeFile(path.join(P, 'x'), 'a')).rejects.toMatchObject(trap)
    await expect(fs.promises.appendFile(path.join(P, 'x'), 'a')).rejects.toMatchObject(trap)
    await expect(
      fs.promises.rename(path.join(outside, 'n'), path.join(P, 'z')),
    ).rejects.toMatchObject(trap)
    await expect(fs.promises.rm(path.join(P, 'existing.txt'))).rejects.toMatchObject(trap)
    await expect(fs.promises.unlink(path.join(P, 'existing.txt'))).rejects.toMatchObject(trap)
    await expect(fs.promises.mkdir(path.join(P, 'd'))).rejects.toMatchObject(trap)
    await expect(
      fs.promises.copyFile(path.join(P, 'existing.txt'), path.join(P, 'c')),
    ).rejects.toMatchObject(trap)
    expect(() => fs.writeFile(path.join(P, 'cb'), 'a', () => {})).toThrow(
      expect.objectContaining(trap),
    )
  })

  it('allows reads, allow roots and paths outside the protected root', async () => {
    expect(fs.readFileSync(path.join(P, 'existing.txt'), 'utf8')).toBe('x')
    fs.writeFileSync(path.join(A, 'ok.txt'), 'ok')
    await fs.promises.writeFile(path.join(outside, 'ok.txt'), 'ok')
    fs.mkdirSync(path.join(outside, 'sub'))
    fs.rmSync(path.join(outside, 'sub'), { recursive: true })
    expect(fs.readFileSync(path.join(A, 'ok.txt'), 'utf8')).toBe('ok')
  })

  it('blocks writes through a symlink that points into the protected root', () => {
    fs.symlinkSync(P, path.join(outside, 'link'))
    expect(() => fs.writeFileSync(path.join(outside, 'link', 'x'), 'a')).toThrow(
      expect.objectContaining(trap),
    )
  })

  it('passes EvaFs writes (withEvaFsWrite) under the protected root', async () => {
    const evafs = createEvaFs({ root: P })
    await evafs.write('file-save', 'saved.txt', 'hi')
    expect(fs.readFileSync(path.join(P, 'saved.txt'), 'utf8')).toBe('hi')
  })

  it('restores the originals on uninstall', () => {
    uninstall()
    fs.writeFileSync(path.join(P, 'free.txt'), 'a')
    expect(fs.existsSync(path.join(P, 'free.txt'))).toBe(true)
    uninstall = installWriteTrap({ protectedRoots: [P], allowRoots: [] })
  })
})
