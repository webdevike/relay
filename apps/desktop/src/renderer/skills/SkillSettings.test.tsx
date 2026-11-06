import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import type { SkillAssistant, SkillDetail, SkillRow } from '@evaos/contract'
import { SkillSettings } from './SkillSettings'
import { resetSkillsForTests, skillsStore } from './skills-store'

const NOW = Date.now()
const ASSISTANTS: SkillAssistant[] = [
  { id: 'nova', title: 'Nova', profile: 'personal', color: '#f76707' },
  { id: 'astra', title: 'Astra', profile: 'work', color: '#228be6' },
  { id: 'polaris', title: 'Polaris', profile: 'personal', color: '#7950f2' },
]
const ROW: SkillRow = {
  name: 'canvas',
  description: 'Build and open boards on the EvaOS Canvas.',
  source: {
    key: 'eva',
    label: 'Eva',
    dir: '~/Eva/.omp/skills/canvas',
    file: '/Users/i/Eva/.omp/skills/canvas/SKILL.md',
  },
  also: [],
  updatedAt: NOW,
  usedBy: ['nova', 'polaris'],
  disabled: false,
  lastUsedAt: NOW - 2 * 3_600_000,
}
const DETAIL: SkillDetail = {
  ...ROW,
  files: [
    { path: 'SKILL.md', size: 4200 },
    { path: 'scripts/validate.sh', size: 312 },
  ],
  stats: null,
  profiles: { nova: 'personal', astra: 'work', polaris: 'personal' },
}

function ui(row: SkillRow = ROW, detail: SkillDetail | null = DETAIL) {
  skillsStore.setState({ list: [row], assistants: ASSISTANTS, available: true, loading: false })
  return render(
    <MantineProvider>
      <SkillSettings row={row} detail={detail} assistants={ASSISTANTS} now={NOW} />
    </MantineProvider>,
  )
}

beforeEach(() => {
  invoke.mockReset()
  show.mockReset()
  resetSkillsForTests()
  invoke.mockImplementation((_c: string, input: { enabled: Record<string, boolean> }) => {
    const on = new Set(ROW.usedBy)
    for (const [id, v] of Object.entries(input.enabled)) {
      if (v) on.add(id)
      else on.delete(id)
    }
    return Promise.resolve({ ok: true, value: { ...ROW, usedBy: [...on] } })
  })
})

describe('SkillSettings', () => {
  it('shows who loads it, the shared profile and the files', () => {
    ui()
    expect(screen.getByTestId('skill-enabled-nova')).toBeChecked()
    expect(screen.getByTestId('skill-enabled-astra')).not.toBeChecked()
    expect(screen.getByText('Nova and Polaris share the personal profile.')).toBeInTheDocument()
    // The folder is the panel header's; the tab does not repeat it.
    expect(screen.queryByLabelText('SKILL.md path')).toBeNull()
    expect(screen.getByText('scripts/validate.sh')).toBeInTheDocument()
    expect(screen.getByText('312 B')).toBeInTheDocument()
    // Nova and Polaris are one profile, so this reads as one assistant only.
    expect(screen.getByTestId('skill-scope-one')).toHaveAttribute('aria-checked', 'true')
  })

  it('turning one assistant off turns off everyone on its profile', () => {
    ui()
    fireEvent.click(screen.getByTestId('skill-enabled-polaris'))
    expect(invoke).toHaveBeenCalledWith('skills.access', {
      name: 'canvas',
      enabled: { polaris: false, nova: false },
    })
    fireEvent.click(screen.getByTestId('skill-enabled-astra'))
    expect(invoke).toHaveBeenLastCalledWith('skills.access', {
      name: 'canvas',
      enabled: { astra: true },
    })
  })

  it('maps the scope cards onto access for every assistant', () => {
    ui()
    fireEvent.click(screen.getByTestId('skill-scope-global'))
    expect(invoke).toHaveBeenLastCalledWith('skills.access', {
      name: 'canvas',
      enabled: { nova: true, astra: true, polaris: true },
    })
  })

  it('narrows a global skill to one assistant', () => {
    ui({ ...ROW, usedBy: ['nova', 'astra', 'polaris'] })
    expect(screen.getByTestId('skill-scope-global')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByTestId('skill-scope-one'))
    expect(invoke).toHaveBeenLastCalledWith('skills.access', {
      name: 'canvas',
      enabled: { nova: true, astra: false, polaris: true },
    })
  })

  it('disables for everyone, and offers to enable when fully off', () => {
    const { unmount } = ui()
    fireEvent.click(screen.getByRole('button', { name: 'Disable skill' }))
    expect(invoke).toHaveBeenLastCalledWith('skills.access', {
      name: 'canvas',
      enabled: { nova: false, astra: false, polaris: false },
    })
    unmount()
    ui({ ...ROW, usedBy: [], lastUsedAt: null }, { ...DETAIL, usedBy: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Enable skill' }))
    expect(invoke).toHaveBeenLastCalledWith('skills.access', {
      name: 'canvas',
      enabled: { nova: true, astra: true, polaris: true },
    })
  })

  it('says when SKILL.md turns the skill off', () => {
    ui({ ...ROW, usedBy: [], disabled: true })
    expect(screen.getByText(/so no assistant loads it/)).toBeInTheDocument()
    expect(screen.getByTestId('skill-enabled-nova')).toBeDisabled()
  })
})
