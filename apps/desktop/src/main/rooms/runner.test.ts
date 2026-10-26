import type { Frame } from '@evaos/chat-core/line-framer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OmpAgentRunner, messageText, presenceOf, privateCwd, toolArgs, toolDetail } from './runner'

const assistant = (content: unknown[], ev?: Record<string, unknown>): Frame => ({
  type: ev ? 'message_update' : 'message_start',
  message: { role: 'assistant', content },
  ...(ev ? { assistantMessageEvent: ev } : {}),
})

describe('presenceOf', () => {
  it('maps the frames omp emits during a turn, in order', () => {
    // Recorded from `omp --mode rpc-ui --tools read,...` answering "read package.json" (2026-10-26).
    const frames: Frame[] = [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'q' }] } },
      assistant([{ type: 'thinking', thinking: '' }]),
      assistant([{ type: 'thinking', thinking: '' }], { type: 'thinking_start', contentIndex: 0 }),
      assistant([{ type: 'thinking', thinking: '**Plan**' }], {
        type: 'thinking_delta',
        delta: '**Plan**',
      }),
      assistant([{ type: 'thinking', thinking: '**Plan**' }], { type: 'thinking_end' }),
      assistant([{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }], {
        type: 'toolcall_start',
      }),
      assistant([{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }], {
        type: 'toolcall_delta',
        delta: '{',
      }),
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      {
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'read',
        args: { path: 'apps/desktop/package.json' },
      },
      { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read' },
      { type: 'message_start', message: { role: 'toolResult', toolCallId: 'c1', content: [] } },
      { type: 'turn_end' },
      { type: 'turn_start' },
      assistant([{ type: 'text', text: 'The' }]),
      assistant([{ type: 'text', text: 'The' }], { type: 'text_start', contentIndex: 0 }),
      assistant([{ type: 'text', text: 'The package' }], { type: 'text_delta', delta: ' package' }),
      assistant([{ type: 'text', text: 'The package.' }], { type: 'text_end' }),
      { type: 'turn_end' },
      { type: 'agent_end', messages: [] },
      { type: 'prompt_result', status: 'completed' },
    ]
    const out = frames.map((f) => presenceOf(f))
    expect(out).toEqual([
      undefined,
      undefined,
      undefined,
      { state: 'thinking' },
      { state: 'thinking' },
      { state: 'thinking' },
      { state: 'thinking' },
      { state: 'thinking' },
      { state: 'thinking' },
      undefined,
      { state: 'reading', detail: 'reading apps/desktop/package.json' },
      { state: 'thinking' },
      undefined,
      undefined,
      undefined,
      { state: 'typing' },
      { state: 'typing' },
      { state: 'typing' },
      { state: 'typing' },
      undefined,
      null,
      undefined,
    ])
  })

  it('a text-only message_start (no reasoning) is typing', () => {
    expect(presenceOf(assistant([{ type: 'text', text: 'Hi' }]))).toEqual({ state: 'typing' })
    expect(presenceOf(assistant([]))).toEqual({ state: 'thinking' })
  })
})

describe('toolDetail', () => {
  it('names the tool and its target, shortened to about 40 chars', () => {
    expect(toolDetail('read', { path: 'apps/desktop/src/main/index.ts' })).toBe(
      'reading apps/desktop/src/main/index.ts',
    )
    const long = toolDetail('read', { path: 'apps/desktop/src/renderer/rooms/rooms-store.test.ts' })
    expect(long).toBe('reading …/src/renderer/rooms/rooms-store.test.ts')
    expect(long.length).toBe('reading '.length + 40)
    expect(toolDetail('grep', { pattern: 'SessionManager' })).toBe('grep SessionManager')
    expect(toolDetail('glob', { pattern: '**/*.ts' })).toBe('glob **/*.ts')
    expect(toolDetail('web_search', { query: 'zod 4 record' })).toBe(
      'searching the web: zod 4 record',
    )
    expect(toolDetail('web_search', {})).toBe('searching the web')
    expect(toolDetail('read', null)).toBe('reading a file')
    expect(toolDetail('bash', { command: 'ls' })).toBe('using bash')
    expect(toolDetail('computer_state', { query: 'Save' })).toBe('using computer_state Save')
  })
})

describe('toolArgs and messageText', () => {
  it('no seat loads extensions or skills; read-only adds the four read tools auto-approved', () => {
    expect(toolArgs('read-only')).toEqual([
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--tools',
      'read,grep,glob,web_search',
      '--approval-mode',
      'yolo',
    ])
    expect(toolArgs('none')).toEqual(['--no-extensions', '--no-skills', '--no-rules', '--no-tools'])
  })

  it('joins text blocks and ignores thinking and tool calls', () => {
    expect(
      messageText({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'a' },
          { type: 'toolCall', name: 'read' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab')
    expect(messageText({ content: 'plain' })).toBe('plain')
    expect(messageText(null)).toBe('')
  })
})

describe('seat cwd', () => {
  // A stand-in omp that records its cwd and argv, then waits for stdin EOF like omp.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-rooms-cwd-'))
  const stub = path.join(dir, 'omp.sh')
  const out = path.join(dir, 'runs')
  fs.writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> "${out}"\nwhile IFS= read -r line; do :; done\nexit 0\n`,
    { mode: 0o755 },
  )
  const evaRoot = path.join(dir, 'eva')
  const repo = path.join(evaRoot, 'work', 'evaos-electron')
  fs.mkdirSync(path.join(evaRoot, '.omp', 'tools'), { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('chat-only seats and the judge run in the private dir, read-only seats in the checkout', async () => {
    const priv = privateCwd(dir)
    expect(priv).toBe(path.join(dir, 'relay-rooms'))
    expect(fs.existsSync(path.join(priv, '.omp'))).toBe(false)
    expect(privateCwd(dir)).toBe(priv)
    const runner = new OmpAgentRunner({ ompBin: stub, live: false, cwd: priv, toolsCwd: repo })
    const none = await runner.start({
      systemPrompt: 'p',
      model: 'm',
      tools: 'none',
      thinking: 'medium',
    })
    const ro = await runner.start({
      systemPrompt: 'p',
      model: 'm',
      tools: 'read-only',
      thinking: 'high',
    })
    await none.stop()
    await ro.stop()
    const real = (p: string): string => fs.realpathSync(p)
    // The two stand-ins write their line as they come up, in either order.
    const runs = fs
      .readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('\t') as [string, string])
    const noneRun = runs.find(([, argv]) => argv.includes('--no-tools'))!
    const roRun = runs.find(([, argv]) => argv.includes('--tools read'))!
    expect(runs).toHaveLength(2)
    expect(real(noneRun[0])).toBe(real(priv))
    expect(real(roRun[0])).toBe(real(repo))
    expect(noneRun[1]).toContain('--no-extensions --no-skills --no-rules --no-tools')
    expect(noneRun[1]).toContain('--thinking medium')
    expect(roRun[1]).toContain(
      '--no-extensions --no-skills --no-rules --tools read,grep,glob,web_search --approval-mode yolo',
    )
    expect(roRun[1]).toContain('--thinking high')
    // Neither cwd is the Eva root, whose .omp/tools would become project tools.
    for (const [cwd] of runs) expect(real(cwd)).not.toBe(real(evaRoot))
  })
})
