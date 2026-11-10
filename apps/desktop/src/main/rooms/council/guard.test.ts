import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { installGuard, type GuardInstall } from './guard'

// Real processes: the shims are /bin/sh scripts and the guard runs in this node.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-guard-test-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const realBin = path.join(root, 'real-bin')
fs.mkdirSync(realBin)
const ran = path.join(root, 'ran.log')
for (const tool of ['git', 'gh', 'wrangler']) {
  fs.writeFileSync(path.join(realBin, tool), `#!/bin/sh\necho "${tool} $*" >> "${ran}"\n`, {
    mode: 0o755,
  })
}

let n = 0
function setup(): { g: GuardInstall; workdir: string; asks: string } {
  const base = path.join(root, `case-${++n}`)
  const workdir = path.join(base, 'room')
  const asks = path.join(base, 'asks')
  fs.mkdirSync(workdir, { recursive: true })
  const g = installGuard({
    workdir,
    asksDir: asks,
    seatId: 'theo',
    path: `${realBin}:/usr/bin:/bin`,
    dir: path.join(base, 'guard'),
    waitMs: 4000,
    pollMs: 20,
  })
  return { g, workdir, asks }
}

const ranLines = (): string[] =>
  fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim().split('\n') : []

/** Answers the first ask that shows up in `asks` with `answer`; resolves with its JSON. */
async function answerFirst(
  asks: string,
  answer: 'allow' | 'deny',
): Promise<Record<string, unknown>> {
  const found = Promise.withResolvers<string>()
  const look = (): void => {
    const f = fs.readdirSync(asks).find((x) => x.endsWith('.json'))
    if (f) found.resolve(f)
  }
  const watcher = fs.watch(asks, look)
  look()
  const f = await found.promise
  watcher.close()
  const body = JSON.parse(fs.readFileSync(path.join(asks, f), 'utf8')) as Record<string, unknown>
  fs.writeFileSync(path.join(asks, `${String(body.id)}.answer`), answer)
  return body
}

/** Runs `cmd` in a shell whose PATH is the seat's, without blocking the event loop. */
function sh(
  g: GuardInstall,
  cwd: string,
  cmd: string,
): Promise<{ code: number | null; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; stderr: string }>()
  const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: { ...process.env, ...g.env } })
  let stderr = ''
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
  child.on('close', (code) => resolve({ code, stderr }))
  return promise
}

function hook(g: GuardInstall, input: unknown): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>()
  const child = spawn('/bin/sh', ['-c', g.hookCommand])
  let out = ''
  child.stdout.on('data', (c: Buffer) => (out += c.toString()))
  child.on('close', () => resolve(out))
  child.stdin.end(JSON.stringify(input))
  return promise
}

describe('seat guard: PATH shims', { timeout: 20_000 }, () => {
  it('git push asks; deny blocks it and the real git never runs', async () => {
    const { g, workdir, asks } = setup()
    const before = ranLines().length
    const run = sh(g, workdir, 'git push origin main')
    const ask = await answerFirst(asks, 'deny')
    expect(ask).toMatchObject({ seatId: 'theo', action: 'git push origin main' })
    expect(typeof ask.at).toBe('string')
    const r = await run
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Isaac did not allow this: git push origin main')
    expect(ranLines().length).toBe(before)
  })

  it('git push runs the real git once allowed; other git calls never ask', async () => {
    const { g, workdir, asks } = setup()
    const run = sh(g, workdir, 'git -C . push')
    await answerFirst(asks, 'allow')
    expect((await run).code).toBe(0)
    expect(ranLines()).toContain('git -C . push')
    expect((await sh(g, workdir, 'git status --short')).code).toBe(0)
    expect(ranLines()).toContain('git status --short')
    expect(fs.readdirSync(asks).filter((f) => f.endsWith('.json'))).toHaveLength(1)
  })

  it('an unanswered ask is denied once the wait is over', async () => {
    const { g, workdir } = setup()
    const r = await sh(g, workdir, 'wrangler deploy')
    expect(r.code).toBe(1)
    expect(ranLines()).not.toContain('wrangler deploy')
  })

  it('gh reads pass, gh writes ask', async () => {
    const { g, workdir, asks } = setup()
    expect((await sh(g, workdir, 'gh pr view 3')).code).toBe(0)
    expect((await sh(g, workdir, 'gh api repos/x/y')).code).toBe(0)
    const run = sh(g, workdir, 'gh api -X POST repos/x/y/issues')
    expect(await answerFirst(asks, 'deny')).toMatchObject({
      action: 'gh api -X POST repos/x/y/issues',
    })
    expect((await run).code).toBe(1)
  })
})

describe('seat guard: PreToolUse hook', { timeout: 20_000 }, () => {
  it('denies a push hidden in a compound shell line, with a reason', async () => {
    const { g, workdir, asks } = setup()
    const out = hook(g, {
      tool_name: 'Bash',
      tool_input: { command: 'cd sub && echo "ok" ; FOO=1 git push --force' },
      cwd: workdir,
    })
    expect(await answerFirst(asks, 'deny')).toMatchObject({ action: 'git push --force' })
    const res = JSON.parse(await out) as { hookSpecificOutput: Record<string, unknown> }
    expect(res.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    })
    expect(String(res.hookSpecificOutput.permissionDecisionReason)).toContain('git push --force')
  })

  it('an allowed hook ask is not asked again by the shim', async () => {
    const { g, workdir, asks } = setup()
    const out = hook(g, { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: workdir })
    await answerFirst(asks, 'allow')
    expect(await out).toBe('')
    expect((await sh(g, workdir, 'git push')).code).toBe(0)
    expect(fs.readdirSync(asks).filter((f) => f.endsWith('.json'))).toHaveLength(1)
  })

  it('writes and deletes outside the room ask; inside the room and in tmp they do not', async () => {
    const { g, workdir, asks } = setup()
    for (const input of [
      { tool_name: 'Write', tool_input: { file_path: path.join(workdir, 'a.txt') }, cwd: workdir },
      { tool_name: 'Edit', tool_input: { file_path: 'b/c.txt' }, cwd: workdir },
      {
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build /tmp/x && echo hi > out.txt' },
        cwd: workdir,
      },
    ]) {
      expect(await hook(g, input)).toBe('')
    }
    expect(fs.existsSync(asks) ? fs.readdirSync(asks) : []).toEqual([])
    const outside = path.join(os.homedir(), 'relay-guard-test-never.txt')
    const write = hook(g, { tool_name: 'Write', tool_input: { file_path: outside }, cwd: workdir })
    expect(await answerFirst(asks, 'deny')).toMatchObject({
      action: `write ${outside} (outside the room)`,
    })
    expect(await write).toContain('"deny"')
  })

  it('reads a Codex shell call given as argv and an apply_patch outside the room', async () => {
    const { g, workdir, asks } = setup()
    const a = hook(g, {
      tool_name: 'Bash',
      tool_input: { command: ['bash', '-lc', 'npm publish'] },
      cwd: workdir,
    })
    expect(await answerFirst(asks, 'deny')).toMatchObject({ action: 'npm publish (publishes)' })
    expect(await a).toContain('"deny"')
    for (const f of fs.readdirSync(asks)) fs.rmSync(path.join(asks, f))
    const far = path.join(os.homedir(), 'relay-guard-test-elsewhere.txt')
    const patch = `*** Begin Patch\n*** Update File: ${far}\n@@\n-a\n+b\n*** End Patch`
    const b = hook(g, { tool_name: 'apply_patch', tool_input: { command: patch }, cwd: workdir })
    const ask = await answerFirst(asks, 'deny')
    expect(String(ask.action)).toContain('elsewhere.txt (outside the room)')
    expect(await b).toContain('"deny"')
  })
})

describe('installGuard', () => {
  it('shims only binaries that exist, and gives each harness the hook', () => {
    const { g } = setup()
    const shims = fs.readdirSync(g.binDir)
    expect(shims).toEqual(expect.arrayContaining(['gh', 'git', 'wrangler']))
    expect(shims).not.toContain('vercel')
    expect(g.env.PATH.startsWith(`${g.binDir}:`)).toBe(true)
    const settings = JSON.parse(g.claudeSettings) as {
      hooks: { PreToolUse: { hooks: { command: string }[] }[] }
    }
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(g.hookCommand)
    expect(g.codexArgs[1]).toContain(JSON.stringify(g.hookCommand))
    expect(spawnSync('/bin/sh', ['-n', path.join(g.binDir, 'git')]).status).toBe(0)
    g.dispose()
    expect(fs.existsSync(g.dir)).toBe(false)
  })
})
