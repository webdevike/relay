import { describe, expect, it } from 'vitest'
import type { Control } from './desktop'
import { gate } from './safety'

const control = (role: string, label: string): Control => ({
  ref: 1,
  token: 't',
  role,
  label,
  line: `${role} (${label})`,
  frame: null,
})

describe('gate', () => {
  it('asks before pressing controls that send, delete, buy or submit', () => {
    expect(
      gate({ type: 'click', ref: 1 }, control('AXButton', 'Send'), 'Mail', 'reply to Bob').kind,
    ).toBe('ask')
    expect(
      gate({ type: 'click', ref: 1 }, control('AXButton', 'Move to Trash'), 'Finder', 'tidy up')
        .kind,
    ).toBe('ask')
    expect(
      gate({ type: 'click', ref: 1 }, control('AXButton', 'Place order'), 'Arc', 'buy it').kind,
    ).toBe('ask')
    expect(gate({ type: 'menu', path: ['File', 'Delete'] }, undefined, 'Notes', 'x').kind).toBe(
      'ask',
    )
    expect(
      gate({ type: 'click', ref: 1 }, control('AXButton', 'Seven'), 'Calculator', '7 x 6').kind,
    ).toBe('ok')
  })

  it('judges a click found in the picture by its target, like a label, and asks before Print', () => {
    const pixel = (target: string) =>
      gate({ type: 'click', target }, undefined, 'Bambu Studio', 'slice it')
    expect(pixel('Print plate').kind).toBe('ask')
    expect(pixel('Send to printer').kind).toBe('ask')
    expect(pixel('Slice plate').kind).toBe('ok')
    // What the picture showed there counts too: a vague target over a Print button asks.
    expect(pixel('the green button top right Print plate').kind).toBe('ask')
  })

  it('asks before any typing or keys in messaging apps, and before send chords anywhere', () => {
    expect(
      gate({ type: 'type', ref: 1, text: 'hi' }, control('AXTextArea', 'Message'), 'Slack', 'x')
        .kind,
    ).toBe('ask')
    expect(gate({ type: 'key', key: 'return' }, undefined, 'Messages', 'x').kind).toBe('ask')
    expect(gate({ type: 'hotkey', keys: ['cmd', 'return'] }, undefined, 'Notes', 'x').kind).toBe(
      'ask',
    )
    expect(gate({ type: 'key', key: 'return' }, undefined, 'TextEdit', 'x').kind).toBe('ok')
    expect(
      gate({ type: 'type', ref: 1, text: 'hi' }, control('AXTextArea', ''), 'TextEdit', 'x').kind,
    ).toBe('ok')
  })

  it('never types into password fields', () => {
    expect(
      gate(
        { type: 'type', ref: 1, text: 'x' },
        control('AXSecureTextField', 'Password'),
        'Arc',
        'log in',
      ).kind,
    ).toBe('refuse')
  })

  it('leaves System Settings switches alone unless the task says to change that one', () => {
    const wifi = control('AXCheckBox', 'Wi-Fi')
    expect(gate({ type: 'click', ref: 1 }, wifi, 'System Settings', 'is Wi-Fi on?').kind).toBe(
      'refuse',
    )
    expect(
      gate({ type: 'click', ref: 1 }, wifi, 'System Settings', 'turn off Bluetooth').kind,
    ).toBe('refuse')
    expect(gate({ type: 'click', ref: 1 }, wifi, 'System Settings', 'turn off Wi-Fi').kind).toBe(
      'ok',
    )
    expect(
      gate({ type: 'click', ref: 1 }, control('AXButton', 'Wi-Fi'), 'System Settings', 'open Wi-Fi')
        .kind,
    ).toBe('ok')
  })
})
