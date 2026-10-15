import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(__dirname, '../../..')
const WRITE_RE =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|rmSync|unlink|unlinkSync|createWriteStream|copyFile|copyFileSync|mkdirSync)\s*\(|\bfs\.(rm|mkdir)\s*\(|\bfsp?\.promises\.(rm|mkdir)\s*\(/
const ALLOWED = new Set([
  'apps/desktop/src/main/config-store.ts',
  // Pure in-memory category editing; its `rename(from, to)` method touches no file.
  'packages/chat-core/src/categories.ts',
])

export function scanSource(text: string): number[] {
  const hits: number[] = []
  text.split('\n').forEach((line, i) => {
    if (WRITE_RE.test(line)) hits.push(i + 1)
  })
  return hits
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'out') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name)) out.push(p)
  }
}

describe('static write scan', () => {
  it('flags write calls in a sample source (self-test)', () => {
    expect(scanSource('const a = 1\nfs.writeFileSync(p, d)\nawait fsp.promises.rm(p)')).toEqual([
      2, 3,
    ])
    expect(scanSource('const x = readFileSync(p)')).toEqual([])
  })

  it('does not flag spawn or execFile calls', () => {
    expect(scanSource("spawn('bun', args)\nexecFile('bun', args, cb)")).toEqual([])
  })

  it('finds no write API outside packages/eva-core/src/fs', () => {
    const files: string[] = []
    for (const dir of ['main', 'renderer', 'preload']) {
      walk(path.join(REPO, 'apps/desktop/src', dir), files)
    }
    for (const pkg of fs.readdirSync(path.join(REPO, 'packages'))) {
      walk(path.join(REPO, 'packages', pkg, 'src'), files)
    }
    const offenders: string[] = []
    for (const file of files) {
      const rel = path.relative(REPO, file).split(path.sep).join('/')
      if (/\.test\.tsx?$/.test(rel) || rel.startsWith('packages/eva-core/src/fs/')) continue
      if (ALLOWED.has(rel)) continue
      for (const line of scanSource(fs.readFileSync(file, 'utf8'))) offenders.push(`${rel}:${line}`)
    }
    expect(offenders).toEqual([])
  })
})
