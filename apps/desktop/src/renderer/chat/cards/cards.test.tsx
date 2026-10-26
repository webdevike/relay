import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import type { Dialog } from '@evaos/chat-core/message'

const invoke = vi.fn(async (..._a: unknown[]) => ({ ok: true, value: { sent: true } }))
vi.mock('../../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => undefined,
}))

import { startHotkeyRouter } from '../../hotkeys/router'
import { chatStore } from '../chat-store'
import { ExtensionUiCard } from './ExtensionUiCard'
import { PendingDialog } from './PendingDialog'
import { QuestionCard } from './QuestionCard'

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider })

const meta = { model: null, thinking: null, contextTokens: null }
const ask: Dialog = {
  kind: 'ask',
  id: 'u1',
  questions: [
    {
      id: 'q1',
      question: 'Which database?',
      options: [
        { label: 'Postgres' },
        { label: 'SQLite' },
        { label: 'MySQL' },
        { label: 'DuckDB' },
      ],
      multi: false,
    },
  ],
}
const select: Dialog = {
  kind: 'select',
  id: 'u2',
  title: 'Pick one',
  options: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label })),
}

let stop: () => void
beforeEach(() => {
  invoke.mockClear()
  stop = startHotkeyRouter()
})
afterEach(() => stop())

const press = (key: string) => fireEvent.keyDown(window, { key, code: `Digit${key}` })

describe('QuestionCard', () => {
  it('re-arms after a failed answer so the user can retry', async () => {
    const onAnswer = vi.fn(async (..._a: unknown[]) => false)
    render(<QuestionCard dialog={select} onAnswer={onAnswer} />)
    await userEvent.click(screen.getByRole('radio', { name: /A$/ }))
    await userEvent.click(screen.getByRole('radio', { name: /B$/ }))
    expect(onAnswer).toHaveBeenCalledTimes(2)
  })

  it('renders a radiogroup with key chips 1 to 4 only', () => {
    const { container } = render(<QuestionCard dialog={select} onAnswer={() => undefined} />)
    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toBeTruthy()
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    expect([...container.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
    ])
  })

  it('a click answers a single-choice select at once, once', async () => {
    const onAnswer = vi.fn()
    render(<QuestionCard dialog={select} onAnswer={onAnswer} />)
    await userEvent.click(screen.getByRole('radio', { name: /B/ }))
    await userEvent.click(screen.getByRole('radio', { name: /C/ }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'select', value: 'B' })
  })

  it('key 3 answers option 3 while nothing is focused', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard dialog={ask} onAnswer={onAnswer} />)
    press('3')
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'ask',
      answers: [{ id: 'q1', picked: ['MySQL'] }],
    })
  })

  it('digits are ignored while an input has focus', () => {
    const onAnswer = vi.fn()
    render(
      <>
        <input data-testid="box" />
        <QuestionCard dialog={ask} onAnswer={onAnswer} />
      </>,
    )
    const box = screen.getByTestId('box')
    box.focus()
    fireEvent.keyDown(box, { key: '3', code: 'Digit3' })
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('digits are ignored inside xterm and for contentEditable', () => {
    const onAnswer = vi.fn()
    render(
      <>
        <div className="xterm">
          <button data-testid="term">t</button>
        </div>
        <div data-testid="ce" contentEditable suppressContentEditableWarning tabIndex={0} />
        <QuestionCard dialog={ask} onAnswer={onAnswer} />
      </>,
    )
    screen.getByTestId('term').focus()
    fireEvent.keyDown(screen.getByTestId('term'), { key: '2', code: 'Digit2' })
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('a key beyond the options is ignored', () => {
    const onAnswer = vi.fn()
    render(
      <QuestionCard
        dialog={{ ...ask, questions: [{ ...ask.questions[0]!, options: [{ label: 'Only' }] }] }}
        onAnswer={onAnswer}
      />,
    )
    press('3')
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('pages through questions and sends one frame from Send answer', async () => {
    const onAnswer = vi.fn()
    const d: Dialog = {
      kind: 'ask',
      id: 'u3',
      questions: [
        ask.questions[0]!,
        {
          id: 'f',
          question: 'Features?',
          options: [{ label: 'Auth' }, { label: 'Search' }],
          multi: true,
        },
      ],
    }
    render(<QuestionCard dialog={d} onAnswer={onAnswer} />)
    expect(screen.getByText('1 of 2')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByRole('radio', { name: /SQLite/ }))
    expect(screen.getByText('2 of 2')).toBeTruthy()
    const send = screen.getByRole('button', { name: 'Send answer' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: /Auth/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Search/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('radio', { name: /SQLite/ }).getAttribute('aria-checked')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onAnswer).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'ask',
      answers: [
        { id: 'q1', picked: ['SQLite'] },
        { id: 'f', picked: ['Auth', 'Search'] },
      ],
    })
  })

  it('a typed answer replaces the options for that question', async () => {
    const onAnswer = vi.fn()
    render(<QuestionCard dialog={ask} onAnswer={onAnswer} />)
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    await userEvent.type(screen.getByRole('textbox', { name: 'Your own answer' }), 'Turso{Enter}')
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'ask', answers: [{ id: 'q1', typed: 'Turso' }] })
  })

  it('select dialogs have no free-form box', () => {
    render(<QuestionCard dialog={select} onAnswer={() => undefined} />)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('arrow keys move focus between options', async () => {
    render(<QuestionCard dialog={select} onAnswer={() => undefined} />)
    const radios = screen.getAllByRole('radio')
    radios[0]!.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(document.activeElement).toBe(radios[2])
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(radios[1])
  })

  it('dead renders disabled options and the caption, and answers nothing', () => {
    const onAnswer = vi.fn()
    render(<QuestionCard dialog={select} dead onAnswer={onAnswer} />)
    expect((screen.getAllByRole('radio')[0] as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('This question can no longer be answered.')).toBeTruthy()
    press('1')
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('renders omp text as text, never as HTML', () => {
    const d: Dialog = { ...select, title: '<img src=x onerror=alert(1)>' }
    const { container } = render(<QuestionCard dialog={d} onAnswer={() => undefined} />)
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('ExtensionUiCard', () => {
  it('confirm focuses Decline; Decline cancels and Confirm confirms', async () => {
    const onAnswer = vi.fn()
    const d: Dialog = { kind: 'confirm', id: 'c', title: 'Proceed?', message: 'm' }
    render(<ExtensionUiCard dialog={d} onAnswer={onAnswer} />)
    const decline = screen.getByRole('button', { name: 'Decline' })
    expect(document.activeElement).toBe(decline)
    await userEvent.click(decline)
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'cancel' })
  })

  it('confirm sends confirmed true', async () => {
    const onAnswer = vi.fn()
    render(
      <ExtensionUiCard
        dialog={{ kind: 'confirm', id: 'c', title: 'Proceed?', message: '' }}
        onAnswer={onAnswer}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'confirm', confirmed: true })
  })

  it('input sends text', async () => {
    const onAnswer = vi.fn()
    render(
      <ExtensionUiCard dialog={{ kind: 'input', id: 'i', title: 'Name' }} onAnswer={onAnswer} />,
    )
    await userEvent.type(screen.getByRole('textbox'), 'abc')
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'text', value: 'abc' })
  })

  it('editor is focused, prefilled, mono and can send or discard', async () => {
    const onAnswer = vi.fn()
    const d: Dialog = { kind: 'editor', id: 'e', title: 'Edit', prefill: 'draft' }
    const { rerender } = render(<ExtensionUiCard dialog={d} onAnswer={onAnswer} />)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(document.activeElement).toBe(box)
    expect(box.value).toBe('draft')
    expect(box.rows).toBeGreaterThanOrEqual(4)
    expect(box.className).toContain('eva-mono')
    await userEvent.click(screen.getByRole('button', { name: 'Discard input' }))
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'cancel' })
    onAnswer.mockClear()
    rerender(<ExtensionUiCard key="2" dialog={d} onAnswer={onAnswer} />)
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'text', value: 'draft' })
  })
})

describe('PendingDialog and the store', () => {
  const open = () => {
    chatStore.setState({ panes: {} })
    chatStore.getState().openPane('pane-1', { file: '/f', title: 't', messages: [], meta })
  }

  it('renders nothing without a dialog and answers through chat.answerUi', async () => {
    open()
    const { container } = render(<PendingDialog paneId="pane-1" />)
    expect(container.querySelector('[data-testid="pending-dialog-slot"]')).toBeNull()
    act(() => {
      chatStore.getState().applyOps('pane-1', [{ op: 'meta', patch: { dialog: select } }], 1)
    })
    await userEvent.click(screen.getByRole('radio', { name: /B/ }))
    expect(invoke).toHaveBeenCalledWith('chat.answerUi', {
      paneId: 'pane-1',
      id: 'u2',
      response: { kind: 'select', value: 'B' },
    })
  })

  it('a dialog cleared by an answer is gone; one cleared by exit becomes the dead card', () => {
    open()
    act(() => {
      chatStore.getState().applyOps('pane-1', [{ op: 'meta', patch: { dialog: select } }], 1)
      chatStore.getState().applyOps('pane-1', [{ op: 'meta', patch: { dialog: null } }], 2)
    })
    expect(chatStore.getState().panes['pane-1']!.deadDialog).toBeNull()
    act(() => {
      chatStore.getState().applyOps('pane-1', [{ op: 'meta', patch: { dialog: select } }], 3)
      chatStore
        .getState()
        .applyOps(
          'pane-1',
          [{ op: 'meta', patch: { dialog: null, connected: false, running: false } }],
          4,
        )
    })
    expect(chatStore.getState().panes['pane-1']!.deadDialog).toMatchObject({ id: 'u2' })
    const { container } = render(<PendingDialog paneId="pane-1" />)
    expect(container.querySelector('[data-dead="true"]')).not.toBeNull()
    act(() => {
      chatStore.getState().applyOps('pane-1', [{ op: 'meta', patch: { connected: true } }], 5)
    })
    expect(chatStore.getState().panes['pane-1']!.deadDialog).toBeNull()
  })
})
