import { describe, expect, it } from 'vitest'
import {
  IMAGE_TOO_LARGE,
  MAX_RELAY_IMAGE_BASE64,
  NO_GIF,
  TOO_MANY_IMAGES,
  answerCommand,
  cmdFrame,
  configureCommand,
  decideCommand,
  relayImages,
  replyCommand,
  subscribeFrame,
  unsubscribeFrame,
} from './commands'

describe('Relay commands', () => {
  it('builds a reply as the next turn, with images only when there are some', () => {
    expect(replyCommand('s1', 'hello')).toEqual({
      kind: 'agent.reply',
      sessionId: 's1',
      text: 'hello',
      submit: true,
    })
    expect(replyCommand('s1', '', [{ mimeType: 'image/png', data: 'AAA' }])).toEqual({
      kind: 'agent.reply',
      sessionId: 's1',
      text: '',
      submit: true,
      images: [{ mimeType: 'image/png', data: 'AAA' }],
    })
  })

  it("keeps a reply's images within what Relay takes", () => {
    const png = { mimeType: 'image/png', data: 'AAA' }
    expect(relayImages([png, { mimeType: 'image/webp', data: 'B' }])).toEqual([
      png,
      { mimeType: 'image/webp', data: 'B' },
    ])
    expect(relayImages([{ mimeType: 'image/gif', data: 'G' }])).toBe(NO_GIF)
    expect(relayImages([png, png, png, png, png])).toBe(TOO_MANY_IMAGES)
    expect(
      relayImages([{ mimeType: 'image/jpeg', data: 'x'.repeat(MAX_RELAY_IMAGE_BASE64 + 1) }]),
    ).toBe(IMAGE_TOO_LARGE)
  })

  it('configures only what changed: title, model as provider and id, thinking level', () => {
    expect(configureCommand('s1', { title: 'New name' })).toEqual({
      kind: 'agent.configure',
      sessionId: 's1',
      title: 'New name',
    })
    expect(
      configureCommand('s1', { model: ['anthropic', 'claude-opus-5-5'], thinking: 'high' }),
    ).toEqual({
      kind: 'agent.configure',
      sessionId: 's1',
      model: { provider: 'anthropic', id: 'claude-opus-5-5' },
      thinkingLevel: 'high',
    })
  })

  it('answers an ask with picks or typed text, and decides an approval from the desktop', () => {
    expect(
      answerCommand('s1', 'k1', [
        { id: 'q1', picked: ['Yes'] },
        { id: 'q2', typed: 'blue' },
      ]),
    ).toEqual({
      kind: 'agent.ask.answer',
      sessionId: 's1',
      askId: 'k1',
      results: [
        { id: 'q1', selectedOptions: ['Yes'] },
        { id: 'q2', selectedOptions: [], customInput: 'blue' },
      ],
    })
    expect(decideCommand('s1', 'call-1', true)).toEqual({
      kind: 'agent.approve',
      sessionId: 's1',
      approvalId: 'call-1',
      confirmed: 'desktop',
    })
    expect(decideCommand('s1', 'call-1', false)).toEqual({
      kind: 'agent.deny',
      sessionId: 's1',
      approvalId: 'call-1',
    })
  })

  it('frames a command under its id, and subscriptions as plain frames', () => {
    expect(cmdFrame('c1', { kind: 'agent.abort', sessionId: 's1' })).toEqual({
      t: 'cmd',
      id: 'c1',
      cmd: { kind: 'agent.abort', sessionId: 's1' },
    })
    expect(subscribeFrame('s1')).toEqual({ t: 'agent.subscribe', sessionId: 's1' })
    expect(unsubscribeFrame('s1')).toEqual({ t: 'agent.unsubscribe', sessionId: 's1' })
  })
})
