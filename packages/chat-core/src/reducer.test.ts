import { describe, expect, it } from 'vitest'
import { EOF_ERROR, LiveReducer, promptRow } from './reducer'
import { makeMessage } from './message'

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

  it('a relay-canvas custom message_end is a canvas row, with or without an id', () => {
    const r = mk()
    const entry = (kind: string, text: string) => ({
      kind,
      roomId: 'r1',
      slug: 'mind-map',
      board: 'Mind map',
      agent: { name: 'Nova', color: '#7c5cff' },
      text,
    })
    const custom = (kind: string, text: string, timestamp: number) => ({
      role: 'custom',
      customType: 'relay-canvas',
      content: text,
      display: true,
      details: entry(kind, text),
      timestamp,
    })
    r.apply({ type: 'message_end', messageId: 'c1', message: custom('start', 'Sketch it', 1) })
    r.apply({ type: 'message_end', message: custom('turn', 'Added.', 2) })
    r.apply({ type: 'message_end', message: custom('end', 'Done.', 3) })
    r.apply({
      type: 'message_end',
      message: { role: 'custom', customType: 'eren', content: 'rounds', display: true },
    })
    expect(r.messages().map((m) => [m.id, m.role, m.canvas?.kind])).toEqual([
      ['c1', 'canvas', 'start'],
      ['canvas-r1-turn-2', 'canvas', 'turn'],
      ['canvas-r1-end-3', 'canvas', 'end'],
    ])
  })

  it('sendPrompt with images labels them and keeps them when omp echoes the prompt', () => {
    const r = mk()
    const sent = r.sendPrompt('look', [{ mimeType: 'image/png', data: 'AAA' }])
    expect(sent.images).toEqual([
      { label: 'Image 1', src: 'data:image/png;base64,AAA', mimeType: 'image/png' },
    ])
    r.apply({ type: 'message_end', messageId: 'u1', message: user('look') })
    const row = r.messages().find((m) => m.role === 'user')!
    expect(row.unconfirmed).toBeUndefined()
    expect(row.images).toHaveLength(1)
    expect(row.images[0]!.src).toBe('data:image/png;base64,AAA')
  })

  it('sendPrompt without images leaves images empty', () => {
    expect(mk().sendPrompt('hi').images).toEqual([])
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
      message: user('<surface>Mac - Relay Desktop</surface>\nhello'),
    })
    expect(res.removed).toEqual(['sent-1'])
    expect(r.messages().map((m) => [m.id, m.text])).toEqual([
      ['a0', 'earlier'],
      ['a1', 'streaming'],
      ['u1', 'hello'],
    ])
  })

  it('dropUnconfirmedRow takes back one pending prompt and nothing else', () => {
    const r = mk()
    r.apply({ type: 'message_end', messageId: 'u0', message: user('earlier') })
    const a = r.sendPrompt('first')
    const b = r.sendPrompt('second')
    expect(r.dropUnconfirmedRow(a.id)).toBe(true)
    expect(r.messages().map((m) => m.text)).toEqual(['earlier', 'second'])
    expect(r.dropUnconfirmedRow(a.id)).toBe(false)
    expect(r.dropUnconfirmedRow('u0')).toBe(false)
    expect(r.messages().map((m) => m.id)).toEqual(['u0', b.id])
  })

  it('a rejected prompt drops the unconfirmed copy and adds a notice', () => {
    const r = mk()
    r.sendPrompt('bad')
    r.apply({ type: 'response', command: 'prompt', success: false, error: 'nope' })
    expect(rows(r)).toEqual([['notice', 'Error: nope', false]])
  })

  it('notice ids stay unique when a rejected prompt shrinks the list', () => {
    const r = mk()
    r.sendPrompt('x')
    r.apply({ type: 'notice', message: 'heads up' })
    r.apply({ type: 'prompt_result', status: 'error', error: { message: 'boom' } })
    const ids = r.messages().map((m) => m.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
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

  it('a new prompt after an unexpected _eof clears the error', () => {
    const r = mk()
    r.apply({ type: '_eof', code: 1 })
    expect(r.error).toBe(EOF_ERROR)
    r.sendPrompt('try again')
    expect(r.error).toBeNull()
    // The next applied frame does not report the error as a change: it is already gone.
    const res = r.apply({ type: 'agent_start' })
    expect(res.meta).toEqual({ running: true })
  })

  it('a select request is held as a dialog with a log row, not auto-cancelled', () => {
    const r = mk()
    const res = r.apply({
      type: 'extension_ui_request',
      id: 'u1',
      method: 'select',
      title: 'Pick',
      options: ['A', 'B'],
    })
    expect(res.effect).toBeUndefined()
    expect(res.meta?.dialog).toMatchObject({ kind: 'select', id: 'u1' })
    expect(r.dialog?.id).toBe('u1')
    expect(r.messages().at(-1)).toMatchObject({ id: 'dialog-u1', role: 'notice', text: 'Pick' })
  })

  it('presentation updates are ignored', () => {
    const r = mk()
    for (const method of ['setWidget', 'notify', 'setStatus']) {
      const res = r.apply({ type: 'extension_ui_request', id: 'x', method })
      expect(res.effect).toBeUndefined()
      expect(res.meta).toBeUndefined()
    }
    expect(r.dialog).toBeNull()
  })

  it('an unreadable ask is cancelled with the notice', () => {
    const r = mk()
    const res = r.apply({ type: 'extension_ui_request', id: 'u9', method: 'ask', questions: 'x' })
    expect(res.effect).toEqual({ type: 'extension_ui_response', id: 'u9', cancelled: true })
    expect(r.messages().at(-1)?.text).toBe(
      "omp asked a question Relay couldn't read, so it was cancelled.",
    )
    expect(r.dialog).toBeNull()
  })

  it('a cancel for the pending id clears the dialog and marks the row dead', () => {
    const r = mk()
    r.apply({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Sure?' })
    const res = r.apply({ type: 'extension_ui_request', id: 'c', method: 'cancel', targetId: 'u1' })
    expect(res.meta?.dialog).toBeNull()
    expect(r.messages().find((m) => m.id === 'dialog-u1')?.text).toBe(
      'This question can no longer be answered.',
    )
  })

  it('a cancel for another id leaves the dialog', () => {
    const r = mk()
    r.apply({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Sure?' })
    r.apply({ type: 'extension_ui_request', id: 'c', method: 'cancel', targetId: 'other' })
    expect(r.dialog?.id).toBe('u1')
  })

  it('answer() rewrites the row and only for the pending id', () => {
    const r = mk()
    r.apply({
      type: 'extension_ui_request',
      id: 'u1',
      method: 'select',
      title: 'Pick',
      options: ['A'],
    })
    expect(r.answer('nope', 'A').dirty).toEqual([])
    expect(r.dialog).not.toBeNull()
    const res = r.answer('u1', 'A')
    expect(res.dirty).toEqual(['dialog-u1'])
    expect(res.meta).toEqual({ dialog: null })
    expect(r.messages().find((m) => m.id === 'dialog-u1')?.text).toBe('Answered: A')
  })

  it('eof with a pending dialog marks it dead and clears it, expected or not', () => {
    for (const expected of [true, false]) {
      const r = mk()
      r.apply({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Sure?' })
      const res = r.apply({ type: '_eof', code: 0, expected })
      expect(res.effect).toBeUndefined()
      expect(res.meta?.dialog).toBeNull()
      expect(r.dialog).toBeNull()
      expect(r.messages().find((m) => m.id === 'dialog-u1')?.text).toBe(
        'This question can no longer be answered.',
      )
    }
  })

  it('cancelPending(abort) drops the dialog so omp is never left blocked', () => {
    const r = mk()
    r.apply({ type: 'extension_ui_request', id: 'u1', method: 'input', title: 'Name?' })
    const res = r.cancelPending('abort')
    expect(res.meta).toEqual({ dialog: null })
    expect(r.dialog).toBeNull()
    expect(r.cancelPending('abort').dirty).toEqual([])
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

  it('get_state with a context window emits it, and thinking level emits a thinking patch', () => {
    const r = mk()
    const res = r.apply({
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        thinkingLevel: 'high',
        contextUsage: { tokens: 42000, contextWindow: 200000 },
      },
    })
    expect(res.meta).toEqual({ contextTokens: 42000, contextWindow: 200000, thinking: 'high' })
    // The same reading again changes nothing.
    const again = r.apply({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { thinkingLevel: 'high', contextUsage: { tokens: 42000, contextWindow: 200000 } },
    })
    expect(again.meta).toBeUndefined()
  })

  it('a zero context window is unknown, not a window', () => {
    const r = mk()
    const res = r.apply({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { contextUsage: { tokens: 900, contextWindow: 0 } },
    })
    expect(res.meta).toEqual({ contextTokens: 900 })
  })

  it('an assistant message end carries usage.contextWindow', () => {
    const r = mk()
    const res = r.apply({
      type: 'message_end',
      messageId: 'a1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 100, contextWindow: 1000 },
      },
    })
    expect(res.meta).toMatchObject({ contextTokens: 100, contextWindow: 1000 })
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

describe('LiveReducer goal and handoff', () => {
  const goal = (status: string, tokensUsed = 4200) => ({
    objective: 'ship it',
    status,
    tokensUsed,
  })

  it('goal_updated sets, pauses and clears the goal', () => {
    const r = mk()
    expect(r.apply({ type: 'goal_updated', goal: goal('active') }).meta?.goal).toEqual({
      objective: 'ship it',
      paused: false,
      tokensUsed: 4200,
    })
    r.apply({ type: 'goal_updated', goal: goal('paused') })
    expect(r.goal?.paused).toBe(true)
    // An unchanged goal says nothing.
    expect(r.apply({ type: 'goal_updated', goal: goal('paused') }).meta).toBeUndefined()
    expect(r.apply({ type: 'goal_updated', goal: goal('dropped') }).meta).toEqual({ goal: null })
  })

  it('get_state reads the goal', () => {
    const r = mk()
    r.apply({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { goal: { enabled: true, mode: 'active', goal: goal('active', 0) } },
    })
    expect(r.goal).toEqual({ objective: 'ship it', paused: false, tokensUsed: 0 })
  })

  it('a goal response takes back the /goal row and says when there is none', () => {
    const r = mk()
    r.sendPrompt('first')
    r.sendPrompt('/goal ship it')
    const res = r.apply({
      type: 'response',
      command: 'goal',
      success: true,
      data: { goal: goal('active') },
    })
    expect(res.removed).toEqual(['sent-2'])
    expect(r.messages().map((m) => m.text)).toEqual(['first'])
    expect(r.goal?.objective).toBe('ship it')
    r.apply({ type: 'response', command: 'goal', success: true, data: { goal: null } })
    expect(r.goal).toBeNull()
    expect(r.messages().map((m) => m.text)).toEqual(['No goal.', 'first'])
  })

  it('/handoff generates until command_output, whose text shows as a notice', () => {
    const r = mk()
    r.sendPrompt('/handoff keep the API notes')
    expect(r.handingOff).toBe(true)
    const res = r.apply({ type: 'command_output', text: 'Handoff done' })
    expect(res.meta).toEqual({ handingOff: false })
    expect(r.messages().map((m) => [m.role, m.text])).toContainEqual(['notice', 'Handoff done'])
    r.sendPrompt('/handoffs')
    expect(r.handingOff).toBe(false)
  })

  it('a builtin that ran without a turn drops its row and ends the handoff', () => {
    const r = mk()
    r.sendPrompt('/handoff')
    const res = r.apply({
      type: 'response',
      command: 'prompt',
      success: true,
      data: { agentInvoked: false },
    })
    expect(res.removed).toEqual(['sent-1'])
    expect(res.meta).toEqual({ handingOff: false })
    r.sendPrompt('/handoff')
    r.apply({ type: 'response', command: 'prompt', success: false, error: 'nope' })
    expect(r.handingOff).toBe(false)
    r.sendPrompt('/handoff')
    r.apply({ type: '_eof', expected: true })
    expect(r.handingOff).toBe(false)
  })
})

describe('LiveReducer.replaceRows', () => {
  const row = (id: string, t = id) => makeMessage(id, 'assistant', t)

  it('reports new, changed and removed rows, and leaves equal rows alone', () => {
    const r = new LiveReducer([row('a'), row('b'), row('c')], { ...meta })
    const res = r.replaceRows([row('a'), row('b', 'B2'), row('d')])
    expect(res).toEqual({ dirty: ['b', 'd'], removed: ['c'] })
    expect(r.messages().map((m) => m.text)).toEqual(['a', 'B2', 'd'])
  })

  it('removes and re-inserts a row whose order changed, so in-place upserts keep the order', () => {
    const r = new LiveReducer([row('a'), row('b'), row('c')], { ...meta })
    const res = r.replaceRows([row('a'), row('c'), row('n'), row('b')])
    // Replaying the ops the renderer gets (removes, then inserts at the final index) gives the list.
    const list = ['a', 'b', 'c'].filter((id) => !res.removed.includes(id))
    const order = ['a', 'c', 'n', 'b']
    for (const id of order.filter((id) => res.dirty.includes(id))) {
      if (list.includes(id)) continue
      list.splice(order.indexOf(id), 0, id)
    }
    expect(list).toEqual(order)
  })

  it('takes model and thinking level and says only what changed', () => {
    const r = new LiveReducer([], { ...meta })
    expect(r.setMeta({ model: ['p', 'm'], thinking: 'high', contextTokens: null })).toEqual({
      model: ['p', 'm'],
      thinking: 'high',
    })
    expect(r.setMeta({ model: ['p', 'm'], thinking: 'high' })).toEqual({})
    expect(r.meta()).toMatchObject({ model: ['p', 'm'], thinking: 'high' })
  })

  it('builds an unconfirmed prompt row with its images inline', () => {
    expect(promptRow('sent-x', 'look', [{ mimeType: 'image/png', data: 'AAA' }])).toMatchObject({
      id: 'sent-x',
      role: 'user',
      text: 'look',
      unconfirmed: true,
      images: [{ label: 'Image 1', src: 'data:image/png;base64,AAA', mimeType: 'image/png' }],
    })
  })
})

describe('LiveReducer timestamps', () => {
  it('stamps the streamed reply and the echoed prompt that replaces the unconfirmed row', () => {
    const r = new LiveReducer([promptRow('sent-1', 'hi')], { ...meta })
    expect(r.messages()[0]!.at).toBeUndefined()
    r.apply({ type: 'message_end', messageId: 'u1', message: { ...user('hi'), timestamp: 100 } })
    r.apply({
      type: 'message_update',
      messageId: 'm1',
      message: { ...asst([text('Hel')]), timestamp: 200 },
    })
    expect(r.messages().map((m) => [m.id, m.at, m.unconfirmed])).toEqual([
      ['u1', 100, undefined],
      ['m1', 200, undefined],
    ])
  })
})
