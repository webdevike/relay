import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { SkillDocBar } from './SkillDocBar'

function ui(conflict = false) {
  const doc = new Y.Doc()
  const state = doc.getMap<unknown>('state')
  const onSave = vi.fn()
  const onReload = vi.fn()
  render(
    <MantineProvider>
      <SkillDocBar
        state={state}
        conflict={conflict}
        busy={false}
        onSave={onSave}
        onReload={onReload}
      />
    </MantineProvider>,
  )
  return { state, onSave, onReload }
}

describe('SkillDocBar', () => {
  it('shows the save control only while the host says the doc is dirty', () => {
    const { state, onSave } = ui()
    expect(screen.getByText('SKILL.md')).toBeInTheDocument()
    expect(screen.queryByTestId('skill-save')).toBeNull()
    expect(screen.queryByText('Unsaved')).toBeNull()

    act(() => state.set('dirty', true))
    expect(screen.getByText('Unsaved')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('skill-save'))
    expect(onSave).toHaveBeenCalledWith(false)

    act(() => state.set('dirty', false))
    expect(screen.queryByTestId('skill-save')).toBeNull()
  })

  it('offers reload or overwrite when SKILL.md changed on disk', () => {
    const { state, onSave, onReload } = ui()
    expect(screen.queryByTestId('skill-disk-changed')).toBeNull()
    act(() => state.set('diskChanged', true))
    expect(screen.getByTestId('skill-disk-changed')).toHaveTextContent('SKILL.md changed on disk.')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }))
    expect(onSave).toHaveBeenCalledWith(true)
  })

  it('shows the banner after a save answered changed-on-disk', () => {
    ui(true)
    expect(screen.getByTestId('skill-disk-changed')).toBeInTheDocument()
  })
})
