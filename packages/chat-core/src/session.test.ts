import { describe, expect, it } from 'vitest'
import { agentRunsByRow } from '@relay/protocol/agent-runs'
import { parseSession, untagged } from './session'

const j = (o: unknown): string => JSON.stringify(o)
const msg = (id: string, parentId: string | null, message: unknown): string =>
  j({ type: 'message', id, parentId, message })

describe('parseSession', () => {
  const branchText = [
    j({ type: 'title', title: 'Demo' }),
    j({ type: 'session', id: 's', cwd: '/x' }),
    msg('a', null, { role: 'user', content: 'first', attribution: 'user' }),
    msg('b', 'a', { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] }),
    msg('c', 'a', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'kept' },
        {
          type: 'toolCall',
          id: 't1',
          name: 'read',
          arguments: { i: 'Reading notes', path: 'a.md' },
        },
      ],
    }),
    msg('d', 'c', {
      role: 'toolResult',
      toolCallId: 't1',
      content: [{ type: 'text', text: 'file body' }],
    }),
    msg('e', 'd', {
      role: 'user',
      content: [{ type: 'text', text: 'handoff' }],
      attribution: 'agent',
    }),
  ].join('\n')

  it('transcript follows the active branch (abandoned branch dropped, hidden handoff)', () => {
    const { messages, title } = parseSession(branchText)
    expect(title).toBe('Demo')
    expect(messages.map((m) => [m.role, m.text, m.detail])).toEqual([
      ['user', 'first', ''],
      ['thinking', 'hmm', ''],
      ['assistant', 'kept', ''],
      ['tool', 'read', 'Reading notes'],
    ])
  })

  it('tool result attach sets result and done status', () => {
    const tool = parseSession(branchText).messages[3]!.tool!
    expect(tool.input).toBe('')
    expect(tool.result).toBe('file body')
    expect(tool.status).toBe('done')
    expect(tool.isError).toBe(false)
  })

  it('tool result with isError becomes failed; unanswered call stays running', () => {
    const text = [
      msg('a', null, {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'false' } },
          { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'sleep 1' } },
        ],
      }),
      msg('b', 'a', { role: 'toolResult', toolCallId: 't1', isError: true, content: 'boom' }),
    ].join('\n')
    const rows = parseSession(text).messages
    expect(rows[0]!.tool).toMatchObject({
      status: 'failed',
      isError: true,
      result: 'boom',
      input: 'false',
    })
    expect(rows[1]!.tool!.status).toBe('running')
  })

  it('strips a leading surface tag and hides agent-attributed prompts', () => {
    expect(untagged('<surface>iPhone - Relay</surface>\nhi')).toBe('hi')
    expect(untagged('<surface>Mac Mini - Relay Desktop</surface>\nhi')).toBe('hi')
    expect(untagged('no tag here')).toBe('no tag here')
    const text = [
      msg('a', null, {
        role: 'user',
        content: '<surface>machine - EvaOS</surface>\nfix the dock',
        attribution: 'user',
      }),
      msg('b', 'a', { role: 'user', content: 'auto', attribution: 'agent' }),
      msg('c', 'b', {
        role: 'user',
        content: '<surface>machine - Relay Desktop</surface>\nand the panel',
        attribution: 'user',
      }),
    ].join('\n')
    expect(parseSession(text).messages.map((m) => m.text)).toEqual([
      'fix the dock',
      'and the panel',
    ])
  })

  it('developer messages, unknown records and malformed lines produce no rows', () => {
    const text = [
      'not json at all',
      j({ type: 'custom', id: 'x', parentId: null, customType: 'whatever' }),
      msg('a', 'x', { role: 'developer', content: 'secret' }),
      '{"broken":',
      msg('b', 'a', { role: 'user', content: 'hi', attribution: 'user' }),
    ].join('\n')
    expect(parseSession(text).messages.map((m) => m.text)).toEqual(['hi'])
  })

  it('assistant error stop reason adds a notice row', () => {
    const text = msg('a', null, {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'rate limited',
    })
    expect(parseSession(text).messages.map((m) => [m.role, m.text])).toEqual([
      ['notice', 'Error: rate limited'],
    ])
  })

  it('session meta comes from the active branch', () => {
    const text = [
      j({ type: 'model_change', id: 'm', parentId: null, model: 'anthropic/claude-opus-5-5' }),
      j({ type: 'thinking_level_change', id: 't', parentId: 'm', thinkingLevel: 'medium' }),
      msg('a', 't', { role: 'user', content: 'hi', attribution: 'user' }),
      msg('b', 'a', {
        role: 'assistant',
        provider: 'openai',
        model: 'gpt-6',
        content: 'x',
        usage: { input: 9 },
      }),
      j({ type: 'thinking_level_change', id: 't2', parentId: 'b', thinkingLevel: 'high' }),
      msg('c', 'a', {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        content: 'y',
        usage: { input: 100, cacheRead: 900, cacheWrite: 20 },
      }),
    ].join('\n')
    expect(parseSession(text).meta).toEqual({
      model: ['anthropic', 'claude-opus-5-5'],
      thinking: 'medium',
      contextTokens: 1020,
    })
    const switched = parseSession(
      `${text}\n${j({ type: 'model_change', id: 'd', parentId: 'c', model: 'openai/gpt-6' })}`,
    ).meta
    expect(switched.model).toEqual(['openai', 'gpt-6'])
    expect(switched.contextTokens).toBe(1020)
    const empty = parseSession(
      `${text}\n${j({ type: 'model_change', id: 'e', parentId: 'a', model: 'openai/gpt-6' })}`,
    ).meta
    expect(empty.contextTokens).toBeNull()
  })

  it('title falls back to the first user message (60 chars) when empty', () => {
    const long = 'x'.repeat(80)
    const text = [
      j({ type: 'title', title: '' }),
      j({ type: 'session', id: 's', cwd: '/x' }),
      msg('a', null, { role: 'user', content: long, attribution: 'user' }),
    ].join('\n')
    expect(parseSession(text).title).toBe('x'.repeat(60))
  })

  it('maps assistant blocks to flat rows in order with stable ids', () => {
    const text = msg('a', null, {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 't' },
        { type: 'text', text: 'body' },
        { type: 'toolCall', id: 'c1', name: 'grep', arguments: { pattern: 'foo' } },
        { type: 'toolCall', id: 'c2', name: 'grep', arguments: { pattern: 'bar' } },
      ],
    })
    expect(parseSession(text).messages.map((m) => [m.id, m.role])).toEqual([
      ['a-thinking', 'thinking'],
      ['a', 'assistant'],
      ['a-tool0', 'tool'],
      ['a-tool1', 'tool'],
    ])
  })

  it('shows relay-canvas custom messages as canvas rows and skips other custom messages', () => {
    const agent = { name: 'Nova', color: '#7c5cff', avatar: '/canvas/avatar/nova' }
    const entry = (id: string, parentId: string, details: unknown, customType = 'relay-canvas') =>
      j({
        type: 'custom_message',
        customType,
        content: `canvas ${id}`,
        display: true,
        details,
        id,
        parentId,
        timestamp: '2026-10-28T10:00:00.000Z',
      })
    const base = { roomId: 'r1', slug: 'mind-map', board: 'Mind map', agent }
    const text = [
      msg('u', null, { role: 'user', content: 'plan it', attribution: 'user' }),
      entry('s', 'u', { ...base, kind: 'start', text: 'Sketch the flow' }),
      entry('e', 's', { note: 1 }, 'eren'),
      entry('t', 'e', {
        ...base,
        kind: 'turn',
        human: { name: 'Isaac', text: 'add login' },
        text: 'Added.',
      }),
      // A broken entry (no room) is not a row.
      entry('x', 't', { ...base, roomId: '', kind: 'end' }),
      entry('n', 'x', { ...base, kind: 'end', text: 'We picked the flow.' }),
    ].join('\n')
    const rows = parseSession(text).messages
    expect(rows.map((m) => [m.id, m.role, m.canvas?.kind ?? null])).toEqual([
      ['u', 'user', null],
      ['s', 'canvas', 'start'],
      ['t', 'canvas', 'turn'],
      ['n', 'canvas', 'end'],
    ])
    expect(rows[1]).toMatchObject({
      text: 'canvas s',
      canvas: { ...base, text: 'Sketch the flow' },
    })
    expect(rows[2]?.canvas?.human).toEqual({ name: 'Isaac', text: 'add login' })
  })
})

describe('specialist agents calls', () => {
  const ask = (id: string, args: unknown) => ({
    type: 'toolCall',
    id,
    name: 'write',
    arguments: {
      path: 'xd://mcp__relay_agents_ask',
      i: 'Asking the web researcher',
      content: JSON.stringify(args),
    },
  })
  const request = { question: 'Who makes the M5?', depth: 'quick' }
  const done = {
    run: 'r1',
    agent: 'web-researcher',
    status: 'done',
    request,
    reply: {
      answer: 'Apple.',
      citations: [
        { url: 'https://apple.com', quote: 'M5', verified: true },
        { url: 'https://x.com', quote: 'maybe', verified: false },
      ],
      model: 'm',
    },
    text: 'Apple.',
    requestedAt: '2026-11-16T10:00:00.000Z',
    seconds: 29.4,
    cost: 0.004,
  }

  it('an xd write to agents_ask is a running agent row, and its result makes it done', () => {
    const call = msg('a', null, {
      role: 'assistant',
      timestamp: 1_000,
      content: [ask('c1', { agent: 'web-researcher', request })],
    })
    const start = j({
      type: 'custom',
      id: 's',
      parentId: 'a',
      customType: 'tool_execution_start',
      data: { toolCallId: 'c1', startedAt: '2026-11-16T09:59:59.000Z' },
    })
    const running = parseSession([call, start].join('\n')).messages
    expect(running).toHaveLength(1)
    expect(running[0]!.agent).toEqual({
      agent: 'web-researcher',
      status: 'running',
      request,
      startedAt: Date.parse('2026-11-16T09:59:59.000Z'),
    })
    expect(running[0]!.tool!.input).not.toContain('xd://')

    const result = msg('r', 's', {
      role: 'toolResult',
      toolCallId: 'c1',
      content: [{ type: 'text', text: JSON.stringify(done, null, 2) }],
    })
    const rows = parseSession([call, start, result].join('\n')).messages
    expect(rows[0]!.agent).toMatchObject({
      run: 'r1',
      agent: 'web-researcher',
      status: 'done',
      text: 'Apple.',
      seconds: 29.4,
      cost: 0.004,
      sources: 1,
    })
    expect(rows[0]!.agent!.reply).not.toHaveProperty('model')
  })

  it('an ask that came back running and a later agents_result fold to one done run', () => {
    const text = [
      msg('a', null, {
        role: 'assistant',
        content: [ask('c1', { agent: 'web-researcher', request })],
      }),
      msg('b', 'a', {
        role: 'toolResult',
        toolCallId: 'c1',
        content: [{ type: 'text', text: JSON.stringify({ ...done, status: 'running' }) }],
      }),
      msg('c', 'b', {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'c2',
            name: 'write',
            arguments: { path: 'xd://mcp__relay_agents_result', content: '{"run":"r1"}' },
          },
        ],
      }),
      msg('d', 'c', {
        role: 'toolResult',
        toolCallId: 'c2',
        content: [{ type: 'text', text: JSON.stringify(done) }],
      }),
      msg('e', 'd', { role: 'assistant', content: [{ type: 'text', text: 'Apple makes it.' }] }),
    ].join('\n')
    const rows = parseSession(text).messages
    expect(rows.map((m) => m.agent?.status)).toEqual(['running', 'done', undefined])
    const byRow = agentRunsByRow(rows, (m) =>
      m.role === 'user' ? 'user' : m.role === 'assistant' ? 'reply' : m.agent,
    )
    expect([...byRow.keys()]).toEqual([2])
    expect(byRow.get(2)).toHaveLength(1)
    expect(byRow.get(2)![0]).toMatchObject({ run: 'r1', status: 'done', sources: 1 })
  })
})

describe('images in transcripts', () => {
  const PNG_1X1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg=='
  const HASH = 'a'.repeat(64)
  const line = (id: string, parent: string | null, message: unknown): string =>
    JSON.stringify({ type: 'message', id, parentId: parent, message })

  it('inline image part gets a data URL and dimensions', () => {
    const { messages } = parseSession(
      line('u', null, {
        role: 'user',
        content: [{ type: 'image', data: PNG_1X1, mimeType: 'image/png' }],
      }),
    )
    expect(messages[0]?.images).toEqual([
      {
        label: 'Image 1',
        src: `data:image/png;base64,${PNG_1X1}`,
        mimeType: 'image/png',
        width: 1,
        height: 1,
      },
    ])
  })

  it('blob reference keeps its token and has no dimensions', () => {
    const { messages } = parseSession(
      line('u', null, {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', data: `blob:sha256:${HASH}`, mimeType: 'image/png' },
        ],
      }),
    )
    expect(messages[0]?.images).toEqual([
      { label: 'Image 1', src: `blob:sha256:${HASH}`, mimeType: 'image/png' },
    ])
  })

  it('non-image bytes and bad tokens get no src', () => {
    const { messages } = parseSession(
      line('u', null, {
        role: 'user',
        content: [
          {
            type: 'image',
            data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'),
            mimeType: 'image/svg+xml',
          },
          { type: 'image', data: 'blob:sha256:../../etc/passwd', mimeType: 'image/png' },
        ],
      }),
    )
    expect(messages[0]?.images).toEqual([{ label: 'Image 1' }, { label: 'Image 2' }])
  })

  it('tool result images attach to the tool row', () => {
    const { messages } = parseSession(
      [
        line('c', null, {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 't1', name: 'screenshot', arguments: {} }],
        }),
        line('d', 'c', {
          role: 'toolResult',
          toolCallId: 't1',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'image', data: PNG_1X1, mimeType: 'image/png' },
          ],
        }),
      ].join('\n'),
    )
    const tool = messages.find((m) => m.role === 'tool')
    expect(tool?.images).toHaveLength(1)
    expect(tool?.images[0]?.width).toBe(1)
  })
})

describe('omp timestamps (reaction keys)', () => {
  it('stamps user and assistant rows with their message timestamp, ids unchanged', () => {
    const text = [
      msg('u', null, { role: 'user', content: 'hi', attribution: 'user', timestamp: 1700 }),
      msg('a', 'u', {
        role: 'assistant',
        timestamp: 1800.9,
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'hello' },
          { type: 'toolCall', id: 't1', name: 'read', arguments: {} },
        ],
      }),
    ].join('\n')
    expect(parseSession(text).messages.map((m) => [m.id, m.role, m.at])).toEqual([
      ['u', 'user', 1700],
      ['a-thinking', 'thinking', undefined],
      ['a', 'assistant', 1800.9],
      ['a-tool0', 'tool', undefined],
    ])
  })

  it('leaves `at` off a message without a numeric timestamp', () => {
    const text = [
      msg('u', null, { role: 'user', content: 'hi', attribution: 'user' }),
      msg('a', 'u', { role: 'assistant', content: 'x', timestamp: '2026-10-20T09:00:00Z' }),
    ].join('\n')
    for (const m of parseSession(text).messages) expect('at' in m).toBe(false)
  })
})

describe('parseSession specialist router', () => {
  const decision = {
    v: 1,
    kind: 'decision',
    id: 'sr-1',
    at: '2026-11-17T20:00:00.000Z',
    assistant: 'nova',
    mode: 'shadow',
    agent: 'web-researcher',
    confidence: 0.86,
    why: 'wants sourced prices',
    alternatives: [],
    threshold: 0.7,
    hinted: false,
    latencyMs: 300,
    prompt: 'x',
  }
  const router = (id: string, parentId: string, data: unknown): string =>
    j({ type: 'custom', id, parentId, customType: 'eva.specialist-router', data })

  it("puts the decision on the user row it judged and the turn's outcome once it is written", () => {
    const head = [
      router('d', 'root', decision),
      j({ type: 'custom', id: 'r', parentId: 'd', customType: 'date-reminder', data: {} }),
      msg('u', 'r', { role: 'user', content: 'prices?', timestamp: 5 }),
      msg('a', 'u', { role: 'assistant', content: [{ type: 'text', text: 'Here.' }] }),
    ]
    const running = parseSession(head.join('\n')).messages
    expect(running.map((m) => m.router?.decision.id)).toEqual(['sr-1', undefined])
    expect(running[0]!.router!.outcome).toBeUndefined()
    const ended = parseSession(
      [
        ...head,
        router('o', 'a', {
          v: 1,
          kind: 'outcome',
          id: 'sr-1',
          at: 'x',
          used: true,
          usedAgents: ['web-researcher'],
        }),
      ].join('\n'),
    ).messages
    expect(ended[0]!.router!.outcome!.used).toBe(true)
    expect(ended).toHaveLength(2)
  })

  it('leaves rows alone without router entries or with junk ones', () => {
    const text = [
      router('d', 'root', { ...decision, v: 2 }),
      msg('u', 'd', { role: 'user', content: 'hi' }),
    ].join('\n')
    expect(parseSession(text).messages[0]).not.toHaveProperty('router')
  })
})
