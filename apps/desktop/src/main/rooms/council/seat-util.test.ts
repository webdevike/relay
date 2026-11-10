import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installWriteTrap } from '@evaos/eva-core'
import { afterEach, describe, expect, it } from 'vitest'
import { keepGenerated } from './seat-util'

const dirs: string[] = []
const traps: (() => void)[] = []
afterEach(() => {
  for (const off of traps.splice(0)) off()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const tmp = (prefix: string): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(d)
  return d
}

describe('keepGenerated', () => {
  it('copies into a seat tree under the Eva root while the app write trap is on', () => {
    // In the app every seat tree sits under the trapped Eva root; an in-process copy threw there
    // and left the turn hanging forever.
    const evaRoot = tmp('eva-')
    const tree = path.join(evaRoot, 'work/rooms/r/seats/d')
    fs.mkdirSync(tree, { recursive: true })
    const made = path.join(tmp('codex-'), 'exec-1.png')
    fs.writeFileSync(made, 'png')
    traps.push(installWriteTrap({ protectedRoots: [evaRoot], allowRoots: [] }))

    const first = keepGenerated([made], tree)
    const second = keepGenerated([made], tree)

    expect(first).toEqual([path.join(tree, 'renders/generated/exec-1.png')])
    expect(second).toEqual([path.join(tree, 'renders/generated/exec-1-2.png')])
    expect(fs.readFileSync(second[0]!, 'utf8')).toBe('png')
  })
})
