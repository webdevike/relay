import { describe, expect, it } from 'vitest'
import { ACTIVE_WITHIN_S, decide, type NotifyEvent, type NotifyState } from './policy'

const event = (over: Partial<NotifyEvent> = {}): NotifyEvent => ({
  key: 'reply:nova:1',
  kind: 'reply',
  assistant: 'nova',
  thread: 'assistant:nova',
  title: 'Nova',
  body: 'Done.',
  silent: false,
  click: { link: 'relay://assistant/nova' },
  ...over,
})

const state = (over: Partial<NotifyState> = {}): NotifyState => ({
  prefs: { enabled: true, muted: [] },
  windowFocused: false,
  visible: new Set(),
  idleSeconds: 5,
  ...over,
})

describe('decide', () => {
  it('shows an event while Isaac is at the Mac and the window is in the background', () => {
    expect(decide(event(), state())).toEqual({ show: true })
  })

  it('shows nothing with the global switch off', () => {
    expect(decide(event(), state({ prefs: { enabled: false, muted: [] } }))).toEqual({
      show: false,
      reason: 'off',
    })
    expect(
      decide(
        event({ kind: 'update', assistant: null, thread: null }),
        state({ prefs: { enabled: false, muted: [] } }),
      ),
    ).toEqual({ show: false, reason: 'off' })
  })

  it('mutes one assistant, for every kind of event it has, and no other', () => {
    const muted = state({ prefs: { enabled: true, muted: ['nova'] } })
    expect(decide(event(), muted)).toEqual({ show: false, reason: 'muted' })
    expect(decide(event({ kind: 'waiting' }), muted)).toEqual({ show: false, reason: 'muted' })
    expect(decide(event({ kind: 'canvas' }), muted)).toEqual({ show: false, reason: 'muted' })
    expect(decide(event({ assistant: 'astra', thread: 'assistant:astra' }), muted)).toEqual({
      show: true,
    })
    // A chat of Isaac's own has no assistant to mute.
    expect(decide(event({ assistant: null, thread: 'chat:/s/a.jsonl' }), muted)).toEqual({
      show: true,
    })
  })

  it('leaves it to the phone after ten idle minutes, and speaks again on the first input', () => {
    expect(decide(event(), state({ idleSeconds: ACTIVE_WITHIN_S - 1 }))).toEqual({ show: true })
    expect(decide(event(), state({ idleSeconds: ACTIVE_WITHIN_S }))).toEqual({
      show: false,
      reason: 'away',
    })
    expect(decide(event({ kind: 'waiting' }), state({ idleSeconds: 3_600 }))).toEqual({
      show: false,
      reason: 'away',
    })
  })

  it('tells about an update however long the Mac has been idle: the phone does not know it', () => {
    const update = event({ kind: 'update', assistant: null, thread: null })
    expect(decide(update, state({ idleSeconds: 3_600 }))).toEqual({ show: true })
  })

  it('stays quiet for a chat in front of a focused window, not for another chat', () => {
    const focused = state({ windowFocused: true, visible: new Set(['assistant:nova']) })
    expect(decide(event(), focused)).toEqual({ show: false, reason: 'visible' })
    expect(decide(event({ assistant: 'astra', thread: 'assistant:astra' }), focused)).toEqual({
      show: true,
    })
    expect(decide(event({ assistant: null, thread: 'chat:/s/a.jsonl' }), focused)).toEqual({
      show: true,
    })
  })

  it('shows a visible chat when the window is not focused (it is behind another app)', () => {
    const behind = state({ windowFocused: false, visible: new Set(['assistant:nova']) })
    expect(decide(event(), behind)).toEqual({ show: true })
  })

  it('leaves events with no thread (a canvas, an update toast) to a focused window', () => {
    const canvas = event({ kind: 'canvas', assistant: null, thread: null })
    expect(decide(canvas, state({ windowFocused: true }))).toEqual({
      show: false,
      reason: 'visible',
    })
    expect(decide(canvas, state())).toEqual({ show: true })
  })
})
