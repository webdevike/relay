import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSeatLauncher, type SeatPresence, type SeatSpec } from './seat'

// Real processes: node stand-ins for omp, Claude Code and Codex that speak each one's wire
// format and log what they were started with to calls.jsonl.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seat-test-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const calls = path.join(dir, 'calls.jsonl')
const codexHome = path.join(dir, 'codex-home')

const standIn = (name: string, body: string): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('fs')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const log = (o) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd(), env: { PATH: process.env.PATH, MDS: process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS }, ...o }) + '\\n')
${body}
`,
    { mode: 0o755 },
  )
  return file
}

const fakeOmp = standIn(
  'omp',
  `log({})
out({ type: 'ready', protocolVersion: 1 })
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.type !== 'prompt') return
  log({ prompt: m.message, images: (m.images || []).length })
  const msg = (text, usage) => ({ role: 'assistant', content: [{ type: 'text', text }], usage })
  out({ type: 'response', command: 'prompt', success: true, id: m.id })
  out({ type: 'message_start', message: { role: 'assistant', content: [] } })
  out({ type: 'message_update', message: { role: 'assistant', content: [] }, assistantMessageEvent: { type: 'thinking_delta' } })
  out({ type: 'message_end', message: msg('', { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 }) })
  out({ type: 'tool_execution_start', toolName: 'read', args: { path: 'a.txt' } })
  out({ type: 'tool_execution_end', toolName: 'read' })
  out({ type: 'message_update', message: msg('echo: ' + m.message), assistantMessageEvent: { type: 'text_delta' } })
  out({ type: 'message_end', message: msg('echo: ' + m.message, { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }) })
  out({ type: 'agent_end' })
}).on('close', () => process.exit(0))`,
)

const fakeClaude = standIn(
  'claude',
  `log({})
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  if (m.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } })
    return
  }
  if (m.type !== 'user') return
  const blocks = m.message.content
  log({ prompt: blocks[0].text, kinds: blocks.map((b) => b.type) })
  const ev = (event) => out({ type: 'stream_event', event })
  ev({ type: 'message_start' })
  ev({ type: 'content_block_start', content_block: { type: 'thinking' } })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/a.ts' } }] } })
  out({ type: 'user', message: { content: [{ type: 'tool_result' }] } })
  ev({ type: 'message_start' })
  ev({ type: 'content_block_start', content_block: { type: 'text' } })
  ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'do' } })
  ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ne' } })
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done',
    usage: { input_tokens: 7, cache_creation_input_tokens: 3, cache_read_input_tokens: 50, output_tokens: 9 } })
}).on('close', () => process.exit(0))`,
)

const fakeCodex = standIn(
  'codex',
  `const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('codex-cli 0.0.0'); process.exit(0) }
let prompt = ''
process.stdin.on('data', (c) => (prompt += c)).on('end', () => {
  log({ prompt })
  const resume = argv[1] === 'resume'
  const id = resume ? argv[argv.length - 2] : 'thread-1'
  if (!resume) out({ type: 'thread.started', thread_id: id })
  out({ type: 'turn.started' })
  out({ type: 'item.completed', item: { type: 'error', message: 'a warning, not a failure' } })
  out({ type: 'item.started', item: { type: 'reasoning', text: '' } })
  out({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } })
  out({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', exit_code: 0 } })
  if (resume) {
    const g = require('path').join(process.env.CODEX_HOME, 'generated_images', id)
    fs.mkdirSync(g, { recursive: true })
    fs.writeFileSync(require('path').join(g, 'exec-1.png'), 'png')
  }
  out({ type: 'item.completed', item: { type: 'agent_message', text: (resume ? 'two: ' : 'one: ') + prompt } })
  // Like codex 0.167: the thread's running totals, earlier turns included.
  const u = resume ? [2500, 2000, 120] : [1000, 800, 50]
  out({ type: 'turn.completed', usage: { input_tokens: u[0], cached_input_tokens: u[1], output_tokens: u[2], reasoning_output_tokens: 20 } })
})`,
)

/** Exits at once: a Claude Code that cannot start. */
const brokenClaude = standIn(
  'broken-claude',
  `process.stderr.write('auth expired\\n'); process.exit(3)`,
)

const callsOf = (bin: string): Array<Record<string, unknown>> =>
  fs
    .readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((c) => c.bin === bin)

let n = 0
function spec(over: Partial<SeatSpec>): SeatSpec {
  const room = path.join(dir, `room-${++n}`)
  const cwd = path.join(room, 'seats', 'theo')
  fs.mkdirSync(cwd, { recursive: true })
  return {
    roomId: `r${n}`,
    seatId: 'theo',
    harness: 'omp',
    model: 'sonnet-5.5',
    thinking: 'high',
    systemPrompt: 'You are Theo.',
    cwd,
    readDirs: [path.join(room, 'refs')],
    workdir: room,
    asksDir: path.join(room, 'asks'),
    ...over,
  }
}

const launcher = (over: { claudeBin?: string; codexBin?: string } = {}) =>
  createSeatLauncher({
    ompBin: fakeOmp,
    claudeBin: fakeClaude,
    codexBin: fakeCodex,
    env: { CODEX_HOME: codexHome },
    ...over,
  })

describe('council seats against stand-in harnesses', { timeout: 20_000 }, () => {
  it('omp: full tools in the worktree, Eva context kept out, usage summed over the turn', async () => {
    const s = spec({ harness: 'omp' })
    const h = await launcher().start(s)
    expect(h.harness).toBe('omp')
    expect(h.fallback).toBeUndefined()
    const presence: SeatPresence[] = []
    const partials: string[] = []
    const r = await h.turn({
      prompt: 'hi',
      onPresence: (p) => presence.push(p),
      onPartial: (t) => partials.push(t),
    })
    expect(r.text).toBe('echo: hi')
    // input = uncached + cache writes; cached = cache reads; summed over both assistant messages.
    expect(r.usage).toEqual({ input: 31, cached: 103, output: 7 })
    expect(r.toolCalls).toBe(1)
    expect(presence).toEqual([
      { state: 'thinking' },
      { state: 'reading', detail: 'reading a.txt' },
      { state: 'thinking' },
      { state: 'typing' },
    ])
    expect(partials.at(-1)).toBe('echo: hi')
    const [call] = callsOf('omp')
    const argv = call!.argv as string[]
    expect(call!.cwd).toBe(fs.realpathSync(s.cwd))
    expect(argv).not.toContain('--no-tools')
    expect(
      argv.slice(argv.indexOf('--approval-mode'), argv.indexOf('--approval-mode') + 2),
    ).toEqual(['--approval-mode', 'yolo'])
    expect(argv[argv.indexOf('--model') + 1]).toBe('anthropic/claude-sonnet-5-5')
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe(s.readDirs[0])
    const config = fs.readFileSync(argv[argv.indexOf('--config') + 1]!, 'utf8')
    expect(config).toContain('context-file:project:AGENTS.md')
    expect(String((call!.env as Record<string, string>).PATH)).toMatch(
      /relay-seat-guard-[^:]+\/bin:/,
    )
    await h.stop()
  })

  it('Claude Code: one stream-json message per turn, images as blocks, usage from the result', async () => {
    const s = spec({ harness: 'claude-code', model: 'opus-5.5', budgetUsd: 2.5 })
    const img = path.join(s.cwd, 'ref.png')
    fs.writeFileSync(img, 'png')
    const h = await launcher().start(s)
    expect(h.harness).toBe('claude-code')
    const presence: SeatPresence[] = []
    const partials: string[] = []
    const r = await h.turn({
      prompt: 'build the head',
      images: [img],
      onPresence: (p) => presence.push(p),
      onPartial: (t) => partials.push(t),
    })
    expect(r.text).toBe('done')
    expect(r.usage).toEqual({ input: 10, cached: 50, output: 9 })
    expect(r.toolCalls).toBe(1)
    expect(presence).toEqual([
      { state: 'thinking' },
      { state: 'reading', detail: 'reading /r/a.ts' },
      { state: 'thinking' },
      { state: 'typing' },
    ])
    expect(partials).toEqual(['do', 'done'])
    const [start, turn] = callsOf('claude')
    expect(turn).toMatchObject({ prompt: 'build the head', kinds: ['text', 'image'] })
    const argv = start!.argv as string[]
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5-5')
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('')
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('2.50')
    expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!)).toHaveProperty('hooks.PreToolUse')
    expect((start!.env as Record<string, string>).MDS).toBe('1')
    // A second turn on the same process.
    expect((await h.turn({ prompt: 'again' })).text).toBe('done')
    expect(callsOf('claude')).toHaveLength(3)
    await h.stop()
  })

  it('Codex: a thread on turn 1, resume on turn 2, usage per turn from thread totals, generated images kept', async () => {
    const s = spec({ harness: 'codex', model: 'sol-6.1', thinking: 'max' })
    const h = await launcher().start(s)
    expect(h.harness).toBe('codex')
    const presence: SeatPresence[] = []
    const one = await h.turn({ prompt: 'look', onPresence: (p) => presence.push(p) })
    expect(one.text).toBe('one: look')
    expect(one.usage).toEqual({ input: 200, cached: 800, output: 50 })
    expect(one.toolCalls).toBe(1)
    expect(one.images).toEqual([])
    expect(presence).toEqual([
      { state: 'thinking' },
      { state: 'reading', detail: 'using bash' },
      { state: 'typing' },
    ])
    const two = await h.turn({ prompt: 'again' })
    expect(two.text).toBe('two: again')
    expect(two.usage).toEqual({ input: 300, cached: 1200, output: 70 })
    expect(two.images).toEqual([path.join(s.cwd, 'renders/generated/exec-1.png')])
    expect(fs.existsSync(two.images[0]!)).toBe(true)
    const [first, second] = callsOf('codex').map((c) => c.argv as string[])
    expect(first!.slice(0, 1)).toEqual(['exec'])
    expect(first![first!.indexOf('-m') + 1]).toBe('gpt-6.1-sol')
    expect(first).toContain('model_reasoning_effort="max"')
    expect(first).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(first![first!.indexOf('-C') + 1]).toBe(s.cwd)
    expect(first!.some((a) => a.startsWith('developer_instructions='))).toBe(true)
    expect(second!.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(second!.slice(-2)).toEqual(['thread-1', '-'])
    expect(second!.some((a) => a.startsWith('developer_instructions='))).toBe(false)
    await h.stop()
  })

  it('falls back to omp with the same model when Codex is missing', async () => {
    const h = await launcher({ codexBin: path.join(dir, 'no-such-codex') }).start(
      spec({ harness: 'codex', model: 'sol-6.1' }),
    )
    expect(h.harness).toBe('omp')
    expect(h.fallback).toBe('Codex CLI is not installed, so Sol runs in omp')
    expect((await h.turn({ prompt: 'x' })).text).toBe('echo: x')
    const argv = callsOf('omp').at(-1)!.argv as string[]
    expect(argv[argv.indexOf('--model') + 1]).toBe('openai-codex/gpt-6.1-sol')
    await h.stop()
  })

  it('falls back to omp when Claude Code fails to start, saying why', async () => {
    const h = await launcher({ claudeBin: brokenClaude }).start(
      spec({ harness: 'claude-code', model: 'opus-5.5' }),
    )
    expect(h.harness).toBe('omp')
    expect(h.fallback).toBe('Claude Code did not start (auth expired), so Opus runs in omp')
    await h.stop()
  })
})
