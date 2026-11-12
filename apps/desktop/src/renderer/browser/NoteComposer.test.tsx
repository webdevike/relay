import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AnnotateMark } from '@evaos/contract'
import { NoteComposer, markLabel } from './NoteComposer'

const button: AnnotateMark = {
  element: { tag: 'button', role: 'button', text: 'Click me', selector: '#btn' },
  region: { x: 24, y: 80, w: 70, h: 22 },
}

const ui = (sending = false) => {
  const onSend = vi.fn()
  const onCancel = vi.fn()
  render(
    <MantineProvider>
      <NoteComposer
        mark={button}
        color="#2f6feb"
        sending={sending}
        onSend={onSend}
        onCancel={onCancel}
      />
    </MantineProvider>,
  )
  const field = screen.getByTestId('annotate-note') as HTMLTextAreaElement
  return { onSend, onCancel, field }
}

describe('NoteComposer', () => {
  it('takes the focus as soon as the mark is made', () => {
    const { field } = ui()
    expect(document.activeElement).toBe(field)
  })

  it('sends the trimmed note on Enter; Shift+Enter is a new line', () => {
    const { onSend, field } = ui()
    fireEvent.change(field, { target: { value: '  bigger\nplease ' } })
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('bigger\nplease')
  })

  it('sends nothing empty', () => {
    const empty = ui()
    fireEvent.change(empty.field, { target: { value: '   ' } })
    fireEvent.keyDown(empty.field, { key: 'Enter' })
    expect(empty.onSend).not.toHaveBeenCalled()
    expect(screen.getByTestId('annotate-send')).toBeDisabled()
  })

  it('does not send again while the note is on its way', () => {
    const { onSend, field } = ui(true)
    fireEvent.change(field, { target: { value: 'again' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('drops the note on Escape and on cancel', () => {
    const { onCancel, field } = ui()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('annotate-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})

describe('markLabel', () => {
  it('names an element by its tag and visible name', () => {
    const label = markLabel(button)
    expect(label).toContain('button')
    expect(label).toContain('Click me')
  })

  it('gives a dragged region its size', () => {
    const label = markLabel({ region: { x: 40, y: 120, w: 100, h: 60 } })
    expect(label).toContain('100')
    expect(label).toContain('60')
  })
})
