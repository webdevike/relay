import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCommand } from '../eva/spawn'
import { deleteSession, readPins, renameViaResume, writePins } from './session-ops'

const REPO = path.resolve(__dirname, '../../../../..')
const FAKE = path.join(REPO, 'fixtures/fake-omp/fake-omp.mjs')

const dirs: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ops-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('pins', () => {
  it('keeps unrelated ids, sorts, de-duplicates and writes pretty JSON with a newline', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'session-pins.json'), '["b","a"]')
    expect(writePins(dir, ['b', 'a', 'c', 'a'])).toEqual(['a', 'b', 'c'])
    const text = fs.readFileSync(path.join(dir, 'session-pins.json'), 'utf8')
    expect(text).toBe('[\n  "a",\n  "b",\n  "c"\n]\n')
    expect(fs.readdirSync(dir)).toEqual(['session-pins.json'])
  })

  it('reads a missing or invalid file as none and skips non-strings', () => {
    const dir = tmp()
    expect(readPins(dir)).toEqual([])
    fs.writeFileSync(path.join(dir, 'session-pins.json'), 'not json')
    expect(readPins(dir)).toEqual([])
    fs.writeFileSync(path.join(dir, 'session-pins.json'), '{"a":1}')
    expect(readPins(dir)).toEqual([])
    fs.writeFileSync(path.join(dir, 'session-pins.json'), '["a",3,"b"]')
    expect(readPins(dir)).toEqual(['a', 'b'])
  })

  it('creates the agent dir when missing', () => {
    const dir = path.join(tmp(), 'nested/agent')
    writePins(dir, ['x'])
    expect(readPins(dir)).toEqual(['x'])
  })
})

describe('deleteSession', () => {
  it('removes the file, its folder and .bak files, and keeps prefix siblings', () => {
    const dir = tmp()
    const f = path.join(dir, 'x.jsonl')
    fs.writeFileSync(f, '{}')
    fs.mkdirSync(path.join(dir, 'x/sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'x/sub/a.txt'), 'a')
    fs.writeFileSync(path.join(dir, 'x.jsonl.1.bak'), 'b')
    fs.writeFileSync(path.join(dir, 'x.jsonl.2.bak'), 'b')
    fs.writeFileSync(path.join(dir, 'x-other.jsonl'), '{}')
    fs.writeFileSync(path.join(dir, 'xy.jsonl'), '{}')
    fs.writeFileSync(path.join(dir, 'x.jsonl.keep'), 'k')
    deleteSession(f)
    expect(fs.readdirSync(dir).sort()).toEqual(['x-other.jsonl', 'x.jsonl.keep', 'xy.jsonl'])
  })

  it('ignores a missing folder and missing file', () => {
    const dir = tmp()
    const f = path.join(dir, 'gone.jsonl')
    expect(() => deleteSession(f)).not.toThrow()
  })
})

describe('renameViaResume', () => {
  const cmdFor = (bin: string, args: string[]) =>
    buildCommand(bin, args, {
      pathEnv: process.env.PATH ?? '',
      homedir: os.homedir(),
      execPath: process.execPath,
      baseEnv: process.env,
    })

  it('sets the title through the fake omp and restores the file mtime', async () => {
    const dir = tmp()
    const file = path.join(dir, 'a.jsonl')
    fs.writeFileSync(
      file,
      '{"type":"title","v":1,"title":"Old"}\n{"type":"session","version":3,"id":"a"}\n',
    )
    const past = new Date(Date.now() - 3_600_000)
    fs.utimesSync(file, past, past)
    const before = fs.statSync(file).mtimeMs
    await renameViaResume({
      cmd: cmdFor(FAKE, ['--mode', 'rpc', '--resume', file]),
      cwd: dir,
      file,
      name: 'New title',
    })
    expect(fs.readFileSync(file, 'utf8')).toContain('"title":"New title"')
    expect(Math.abs(fs.statSync(file).mtimeMs - before)).toBeLessThan(5)
  })

  it('times out when the child never answers, ends stdin and rejects with rename-failed', async () => {
    const dir = tmp()
    const file = path.join(dir, 'a.jsonl')
    fs.writeFileSync(file, '{}\n')
    const script = path.join(dir, 'silent.mjs')
    fs.writeFileSync(
      script,
      "process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000)\n",
    )
    await expect(
      renameViaResume({
        cmd: { file: process.execPath, argv: [script], env: process.env },
        cwd: dir,
        file,
        name: 'x',
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: 'rename-failed' })
  })

  it('rejects with rename-failed when the child refuses', async () => {
    const dir = tmp()
    const file = path.join(dir, 'a.jsonl')
    fs.writeFileSync(file, '{}\n')
    const script = path.join(dir, 'refuse.mjs')
    fs.writeFileSync(
      script,
      "process.stdin.on('data', () => { console.log(JSON.stringify({id:'evaos-rename',type:'response',success:false,error:'no'})) }); process.stdin.on('end', () => process.exit(0))\n",
    )
    await expect(
      renameViaResume({
        cmd: { file: process.execPath, argv: [script], env: process.env },
        cwd: dir,
        file,
        name: 'x',
      }),
    ).rejects.toMatchObject({ code: 'rename-failed' })
  })

  it('never uses a shell: shell metacharacters in the name stay data', async () => {
    const dir = tmp()
    const file = path.join(dir, 'a.jsonl')
    fs.writeFileSync(file, '{"type":"title","v":1,"title":"Old"}\n')
    const name = '$(touch pwned); `id` "q"'
    await renameViaResume({
      cmd: cmdFor(FAKE, ['--mode', 'rpc', '--resume', file]),
      cwd: dir,
      file,
      name,
    })
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toContain(JSON.stringify(name).slice(1, -1))
  })
})
