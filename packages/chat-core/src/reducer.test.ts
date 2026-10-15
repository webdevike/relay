import { describe, expect, it } from 'vitest'
import { EOF_ERROR, LiveReducer } from './reducer'

const meta = { model: null, thinking: null, contextTokens: null }
const asst = (content: unknown[]) => ({ role: 'assistant', content })
const text = (t: string) => ({ type: 'text', text: t })
const user = (t: string) => ({ role: 'user', content: [text(t)] })
const mk = () => new LiveReducer([], { ...meta })
const rows = (r: LiveReducer) => r.messages().map((m) => [m.role, m.text, m.streaming] as const)

describe('LiveReducer', () => {
  it('streams a reply from full snapshots and settles on message_end', () => {
    const r = mk()
    r.apply({ type: 'agent_start' })
    expect(r.running).toBe(true)
    r.apply({ type: 'message_start', messageId: 'm1', message: asst([]) })
    r.apply({ type: 'message_update', messageId: 'm1', message: asst([text('Look')]) })
    expect(rows(r)).toEqual([['assistant', 'Look', true]])
    r.apply({ type: 'message_update', messageId: 'm1', message: asst([text('Looking')]) })
    r.apply({ type: 'message_update', messageId: 'm1', message: asst([text('Looking up')]) })
    r.apply({ type: 'message_end', messageId: 'm1', message: asst([text('Looking up now')]) })
    expect(rows(r)).toEqual([['assistant', 'Looking up now', false]])
    r.apply({ type: 'agent_end', yielded: true })
    expect(r.running).toBe(false)
  })

  it('agent_end that continues keeps working', () => {
    const r = mk()
    r.apply({ type: 'agent_start' })
    r.apply({ type: 'agent_end', yielded: false })
    expect(r.running).toBe(true)
  })

  it('shows thinking and tool rows with stable ids in content order', () => {
    const r = mk()
    const content = [
      { type: 'thinking', thinking: 'hmm' },
      text('Looking'),
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
    ]
    r.apply({ type: 'message_update', messageId: 'm1', message: asst(content) })
    expect(r.messages().map((m) => [m.id, m.role])).toEqual([
      ['m1-thinking', 'thinking'],
      ['m1', 'assistant'],
      ['m1-tool0', 'tool'],
    ])
    r.apply({ type: 'message_end', messageId: 'm1', message: asst(content) })
    expect(r.messages().map((m) => m.id)).toEqual(['m1-thinking', 'm1', 'm1-tool0'])
  })

  it('tool_execution_end attaches the result and sets status', () => {
    const r = mk()
    r.apply({
      type: 'message_end',
      messageId: 'm1',
      message: asst([{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }]),
    })
    const res = r.apply({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      isError: false,
      result: 'ok',
    })
    expect(res.dirty).toEqual(['m1-tool0'])
    expect(r.messages()[0]!.tool).toMatchObject({ status: 'done', result: 'ok', isError: false })
    r.apply({ type: 'tool_execution_end', toolCallId: 'c1', isError: true })
    expect(r.messages()[0]!.tool).toMatchObject({ status: 'failed', isError: true })
  })

  it('a toolResult message_end attaches output to its row', () => {
    const r = mk()
    r.apply({
      type: 'message_end',
      messageId: 'm1',
      message: asst([{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }]),
    })
    r.apply({
      type: 'message_end',
      messageId: 't1',
      message: { role: 'toolResult', toolCallId: 'c1', content: [text('file body')] },
    })
    expect(r.messages()).toHaveLength(1)
    expect(r.messages()[0]!.tool).toMatchObject({ result: 'file body', status: 'done' })
  })

  it('a sent prompt shows at once and omps echo replaces it in place', () => {
    const r = mk()
    r.apply({ type: 'message_end', messageId: 'a0', message: asst([text('earlier')]) })
    const sent = r.sendPrompt('hello')
    expect(sent.id).toBe('sent-1')
    expect(sent.unconfirmed).toBe(true)
    r.apply({ type: 'message_update', messageId: 'a1', message: asst([text('streaming')]) })
    // Assistant text arrives before the echo but stays above the unconfirmed prompt.
    expect(r.messages().map((m) => m.id)).toEqual(['a0', 'a1', 'sent-1'])
    const res = r.apply({
      type: 'message_end',
      messageId: 'u1',
      message: user('<surface>Mac - EvaOS</surface>\nhello'),
    })
    expect(res.removed).toEqual(['sent-1'])
    expect(r.messages().map((m) => [m.id, m.text])).toEqual([
      ['a0', 'earlier'],
      ['a1', 'streaming'],
      ['u1', 'hello'],
    ])
  })

  it('a rejected prompt drops the unconfirmed copy and adds a notice', () => {
    const r = mk()
    r.sendPrompt('bad')
    r.apply({ type: 'response', command: 'prompt', success: false, error: 'nope' })
    expect(rows(r)).toEqual([['notice', 'Error: nope', false]])
  })

  it('prompt_result error and aborted add notices', () => {
    const r = mk()
    r.sendPrompt('x')
    r.apply({ type: 'prompt_result', status: 'error', error: { message: 'boom' } })
    expect(r.messages().map((m) => m.text)).toEqual(['Error: boom'])
    r.apply({ type: 'prompt_result', status: 'aborted' })
    expect(r.messages().map((m) => m.text)).toEqual(['Error: boom', 'Stopped.'])
  })

  it('_eof while running ends the session with an error; _stderr is kept but not shown', () => {
    const r = mk()
    r.apply({ type: 'agent_start' })
    for (let i = 0; i < 25; i++) r.apply({ type: '_stderr', line: `l${i}` })
    expect(r.stderrLines()).toHaveLength(20)
    expect(r.stderrLines()[0]).toBe('l5')
    expect(r.messages()).toHaveLength(0)
    const res = r.apply({ type: '_eof', code: 1 })
    expect(r.running).toBe(false)
    expect(res.meta).toMatchObject({ running: false, error: EOF_ERROR })
  })

  it('an expected _eof (we closed stdin) is not an error', () => {
    const r = mk()
    const res = r.apply({ type: '_eof', expected: true })
    expect(res.meta?.error).toBeUndefined()
  })

  it('dialog requests are cancelled, presentation updates are not', () => {
    const r = mk()
    expect(r.apply({ type: 'extension_ui_request', id: 'u1', method: 'select' }).effect).toEqual({
      type: 'extension_ui_response',
      id: 'u1',
      cancelled: true,
    })
    expect(
      r.apply({ type: 'extension_ui_request', id: 'u2', method: 'setWidget' }).effect,
    ).toBeUndefined()
    expect(
      r.apply({ type: 'extension_ui_request', id: 'u3', method: 'notify' }).effect,
    ).toBeUndefined()
    expect(
      r.apply({ type: 'extension_ui_request', id: 'u4', method: 'setStatus' }).effect,
    ).toBeUndefined()
  })

  it('get_state fills model and context, model changes ask for a re-read', () => {
    const r = mk()
    const res = r.apply({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { model: { provider: 'anthropic', id: 'o' }, contextUsage: { tokens: 250 } },
    })
    expect(res.meta).toEqual({ model: ['anthropic', 'o'], contextTokens: 250 })
    expect(r.apply({ type: 'model_changed' }).effect).toEqual({ type: 'get_state' })
  })

  it('unknown frames change nothing', () => {
    const r = mk()
    const res = r.apply({ type: 'something_new', x: 1 })
    expect(res).toEqual({ dirty: [], removed: [] })
    expect(r.messages()).toHaveLength(0)
  })

  it('a steer sent mid-turn stays the last row, unconfirmed, until its echo replaces it in place', () => {
    const r = mk()
    r.sendPrompt('first')
    r.apply({ type: 'agent_start' })
    r.apply({ type: 'message_end', messageId: 'u1', message: user('first') })
    r.apply({ type: 'message_update', messageId: 'a1', message: asst([text('working')]) })
    const steer = r.sendPrompt('Also this')
    expect(steer.unconfirmed).toBe(true)
    r.apply({ type: 'message_update', messageId: 'a1', message: asst([text('working more')]) })
    expect(r.messages().map((m) => m.id)).toEqual(['u1', 'a1', steer.id])
    expect(r.messages().at(-1)!.unconfirmed).toBe(true)
    r.apply({ type: 'message_end', messageId: 'a1', message: asst([text('done one')]) })
    expect(r.messages().at(-1)!.id).toBe(steer.id)
    const res = r.apply({ type: 'message_end', messageId: 'u2', message: user('Also this') })
    expect(res.removed).toEqual([steer.id])
    expect(r.messages().map((m) => [m.id, m.unconfirmed ?? false])).toEqual([
      ['u1', false],
      ['a1', false],
      ['u2', false],
    ])
  })

  it('the abort tail keeps the partial text, stops running and adds no error', () => {
    const r = mk()
    r.apply({ type: 'agent_start' })
    r.apply({ type: 'message_update', messageId: 'a1', message: asst([text('partial text')]) })
    r.apply({
      type: 'message_end',
      messageId: 'a1',
      message: { ...asst([text('partial text')]), stopReason: 'aborted' },
    })
    r.apply({ type: 'agent_end', yielded: true })
    r.apply({ type: 'prompt_result', status: 'aborted', sessionSettled: true })
    expect(r.running).toBe(false)
    expect(r.messages().some((m) => m.text.startsWith('Error'))).toBe(false)
    expect(r.messages()[0]).toMatchObject({ role: 'assistant', text: 'partial text' })
  })
})
