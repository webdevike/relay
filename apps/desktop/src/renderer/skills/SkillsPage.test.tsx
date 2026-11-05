import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))
// The editor needs a live host room; its own pieces are tested apart.
vi.mock('./SkillEditor', () => ({
  SkillEditor: ({ name }: { name: string }) => <div data-testid="editor-stub">{name}</div>,
}))

import type { SkillDetail, SkillList, SkillRow } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { resetReloadForTests } from '../reload/reload'
import { SkillsPage } from './SkillsPage'
import { requestSkill } from './skill-request'
import { resetSkillsForTests, skillsStore } from './skills-store'

const NOW = Date.now()
const row = (name: string, over: Partial<SkillRow> = {}): SkillRow => ({
  name,
  description: `${name} things`,
  source: {
    key: 'eva',
    label: 'Eva',
    dir: `~/Eva/.omp/skills/${name}`,
    file: `/x/${name}/SKILL.md`,
  },
  also: [],
  updatedAt: NOW - 2 * 86_400_000,
  usedBy: ['nova'],
  disabled: false,
  lastUsedAt: null,
  ...over,
})
const LIST: SkillList = {
  available: true,
  skills: [
    row('canvas', { description: 'Build and open boards on the EvaOS Canvas.' }),
    row('adhd', { description: 'Parallel divergent ideation', usedBy: ['nova', 'polaris'] }),
    row('cloudflare', {
      source: { key: 'agents', label: '.agents', dir: '~/.agents/skills/cloudflare', file: '/a' },
      also: [{ key: 'claude', label: '.claude', dir: '~/.claude/skills/cloudflare', file: '/c' }],
    }),
  ],
  assistants: [
    { id: 'nova', title: 'Nova', profile: 'personal', color: '#f76707' },
    { id: 'polaris', title: 'Polaris', profile: 'personal', color: '#7950f2' },
  ],
}
const detail = (r: SkillRow): SkillDetail => ({
  ...r,
  files: [{ path: 'SKILL.md', size: 4200 }],
  usage: { lastUsedAt: null, lastUsedBy: null, loads30d: 0 },
  profiles: { nova: 'personal', polaris: 'personal' },
})

function answer(list: SkillList = LIST) {
  invoke.mockImplementation((channel: string, input: { name?: string }) => {
    if (channel === 'skills.list') return Promise.resolve({ ok: true, value: list })
    if (channel === 'skills.detail') {
      const r = list.skills.find((s) => s.name === input.name)!
      return Promise.resolve({ ok: true, value: detail(r) })
    }
    return Promise.resolve({ ok: false, error: { code: 'x', message: 'no' } })
  })
}

function ui() {
  return render(
    <MantineProvider>
      <SkillsPage place={placeOf('skills')} />
    </MantineProvider>,
  )
}

const names = () => screen.getAllByTestId(/^skill-row-/).map((r) => r.getAttribute('data-skill'))

beforeEach(() => {
  invoke.mockReset()
  resetSkillsForTests()
  resetReloadForTests()
})

describe('SkillsPage', () => {
  it('lists the skills by name with their source, users and age', async () => {
    answer()
    ui()
    expect(await screen.findByTestId('skill-row-canvas')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByTestId('skills-count')).toHaveTextContent('3 available to your assistants')
    expect(names()).toEqual(['adhd', 'canvas', 'cloudflare'])
    const cf = screen.getByTestId('skill-row-cloudflare')
    expect(within(cf).getByText('.agents +1')).toBeInTheDocument()
    expect(within(cf).getByText('2d ago')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('skill-row-adhd')).getByRole('img', { name: 'Nova, Polaris' }),
    ).toBeInTheDocument()
    expect(screen.getByTitle('Build and open boards on the EvaOS Canvas.')).toBeInTheDocument()
  })

  it('searches names and descriptions and flips the name sort', async () => {
    answer()
    ui()
    await screen.findByTestId('skill-row-canvas')
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'boards' } })
    expect(names()).toEqual(['canvas'])
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sort by name' }))
    expect(names()).toEqual(['cloudflare', 'canvas', 'adhd'])
  })

  it('selects a row into the panel and moves with the arrow keys', async () => {
    answer()
    ui()
    fireEvent.click(await screen.findByTestId('skill-row-canvas'))
    const panel = await screen.findByTestId('skill-panel')
    expect(within(panel).getByText('~/Eva/.omp/skills/canvas')).toBeInTheDocument()
    expect(within(panel).getByRole('tab', { name: 'Editor' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByTestId('editor-stub')).toHaveTextContent('canvas')
    expect(invoke).toHaveBeenCalledWith('skills.detail', { name: 'canvas' })
    expect(screen.getByTestId('skill-row-canvas')).toHaveAttribute('aria-selected', 'true')

    // Up and Down move focus between rows (Relay's list); the focused row is the selected one.
    const canvasRow = screen.getByTestId('skill-row-canvas')
    act(() => canvasRow.focus())
    fireEvent.keyDown(canvasRow, { key: 'ArrowDown' })
    expect(skillsStore.getState().selected).toBe('cloudflare')
    fireEvent.keyDown(screen.getByTestId('skill-row-cloudflare'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByTestId('skill-row-canvas'), { key: 'ArrowUp' })
    expect(skillsStore.getState().selected).toBe('adhd')
    // From the search, the arrows select without leaving the field.
    fireEvent.keyDown(screen.getByLabelText('Search skills'), { key: 'ArrowDown' })
    expect(skillsStore.getState().selected).toBe('canvas')

    fireEvent.click(screen.getByTestId('skill-panel-close'))
    expect(screen.queryByTestId('skill-panel')).toBeNull()
  })

  it('takes a skill a link asked for before the page mounted', async () => {
    answer()
    requestSkill('adhd')
    ui()
    expect(await screen.findByTestId('skill-panel')).toHaveAccessibleName('adhd')
  })

  it('focuses the search on / while the page is shown', async () => {
    answer()
    ui()
    await screen.findByTestId('skill-row-canvas')
    const press = () =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }))
      })
    // jsdom lays nothing out, so every element reads as hidden until offsetParent is given.
    press()
    expect(screen.getByLabelText('Search skills')).not.toHaveFocus()
    const shown = vi
      .spyOn(HTMLElement.prototype, 'offsetParent', 'get')
      .mockReturnValue(document.body)
    press()
    expect(screen.getByLabelText('Search skills')).toHaveFocus()
    shown.mockRestore()
  })

  it('says so when there is no Relay host on this Mac', async () => {
    answer({ skills: [], assistants: [], available: false, error: 'no host' })
    ui()
    expect(await screen.findByTestId('skills-unavailable')).toHaveTextContent(
      'Skills needs the Relay host running on this Mac.',
    )
    expect(screen.queryByLabelText('Search skills')).toBeNull()
  })

  it('shows a quiet empty state without skills', async () => {
    answer({ ...LIST, skills: [] })
    ui()
    await waitFor(() => expect(screen.getByTestId('skills-empty')).toBeInTheDocument())
  })
})
