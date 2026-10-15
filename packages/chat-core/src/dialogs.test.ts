import { describe, expect, it } from 'vitest'
import { dialogResponse, dialogStatus, parseDialog, UNREADABLE_ASK_NOTICE } from './dialogs'

const req = (o: Record<string, unknown>) => ({ type: 'extension_ui_request', id: 'q1', ...o })

describe('parseDialog', () => {
  it('parses select with option details', () => {
    expect(
      parseDialog(
        req({
          method: 'select',
          title: 'T',
          options: ['A', 'B'],
          optionDetails: [{}, { description: 'second' }],
        }),
      ),
    ).toEqual({
      dialog: {
        kind: 'select',
        id: 'q1',
        title: 'T',
        options: [{ label: 'A' }, { label: 'B', description: 'second' }],
      },
    })
  })
  it('parses confirm', () => {
    expect(parseDialog(req({ method: 'confirm', title: 'Sure?', message: 'm' }))).toEqual({
      dialog: { kind: 'confirm', id: 'q1', title: 'Sure?', message: 'm' },
    })
  })
  it('parses input with placeholder', () => {
    expect(parseDialog(req({ method: 'input', title: 'Name', placeholder: 'x' }))).toEqual({
      dialog: { kind: 'input', id: 'q1', title: 'Name', placeholder: 'x' },
    })
  })
  it('parses editor with prefill', () => {
    expect(parseDialog(req({ method: 'editor', title: 'Notes', prefill: 'hi' }))).toEqual({
      dialog: { kind: 'editor', id: 'q1', title: 'Notes', prefill: 'hi' },
    })
  })
  it('ignores presentation methods and frames without id', () => {
    expect(parseDialog(req({ method: 'notify' }))).toBeNull()
    expect(parseDialog(req({ method: 'setStatus' }))).toBeNull()
    expect(parseDialog({ method: 'select', options: [] })).toBeNull()
  })
  it('parses ask questions', () => {
    const r = parseDialog(
      req({
        method: 'ask',
        questions: [
          {
            id: 'a',
            question: 'Which?',
            header: 'H',
            options: [{ label: 'x' }, { label: 'y', description: 'd' }],
            recommended: 1,
            multi: true,
          },
          { id: 'b', question: 'Other?', options: [{ label: 'z' }] },
        ],
      }),
    )
    expect(r).toEqual({
      dialog: {
        kind: 'ask',
        id: 'q1',
        questions: [
          {
            id: 'a',
            question: 'Which?',
            header: 'H',
            options: [{ label: 'x' }, { label: 'y', description: 'd' }],
            recommended: 1,
            multi: true,
          },
          { id: 'b', question: 'Other?', options: [{ label: 'z' }], multi: false },
        ],
      },
    })
  })
  it('flags unreadable asks', () => {
    expect(parseDialog(req({ method: 'ask' }))).toEqual({ unreadable: { id: 'q1' } })
    expect(parseDialog(req({ method: 'ask', questions: [{ id: 'a' }] }))).toEqual({
      unreadable: { id: 'q1' },
    })
    expect(UNREADABLE_ASK_NOTICE).toContain('cancelled')
  })
  it('names the cancel target', () => {
    expect(parseDialog({ id: 'x', method: 'cancel', targetId: 'q1' })).toEqual({
      cancelTarget: 'q1',
    })
  })
})

describe('dialogResponse', () => {
  it('maps each answer to its frame', () => {
    const type = 'extension_ui_response'
    expect(dialogResponse('q1', { kind: 'select', value: 'B' })).toEqual({
      type,
      id: 'q1',
      value: 'B',
    })
    expect(dialogResponse('q1', { kind: 'confirm', confirmed: false })).toEqual({
      type,
      id: 'q1',
      confirmed: false,
    })
    expect(dialogResponse('q1', { kind: 'text', value: 'hi' })).toEqual({
      type,
      id: 'q1',
      value: 'hi',
    })
    expect(dialogResponse('q1', { kind: 'cancel' })).toEqual({ type, id: 'q1', cancelled: true })
    expect(
      dialogResponse('q1', {
        kind: 'ask',
        answers: [
          { id: 'a', picked: ['x'] },
          { id: 'b', typed: 'free' },
        ],
      }),
    ).toEqual({
      type,
      id: 'q1',
      answers: [
        { id: 'a', selectedOptions: ['x'] },
        { id: 'b', selectedOptions: [], customInput: 'free' },
      ],
    })
  })
})

describe('dialogStatus', () => {
  it('is confirm only for confirm', () => {
    expect(dialogStatus({ kind: 'confirm', id: 'a', title: '', message: '' })).toBe('confirm')
    expect(dialogStatus({ kind: 'input', id: 'a', title: '' })).toBe('other')
  })
})
