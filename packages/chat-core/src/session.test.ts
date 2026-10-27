import { describe, expect, it } from 'vitest'
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
