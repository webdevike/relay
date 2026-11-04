import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { placeOf } from '@evaos/shell-core'
import { parseAppLink } from '@evaos/chat-core/widget'
import { AgentLinkParamsSchema, appLinkFor } from '@evaos/contract'

const { show, hide } = vi.hoisted(() => ({ show: vi.fn(), hide: vi.fn() }))
vi.mock('../ipc', () => ({
  invoke: vi.fn(async (channel: string) =>
    channel === 'settings.load'
      ? {
          ok: true,
          value: { show_thinking: false, show_tools: false, harness: 'omp', favorite_models: [] },
        }
      : channel === 'settings.save'
        ? {
            ok: true,
            value: { show_thinking: true, show_tools: false, harness: 'omp', favorite_models: [] },
          }
        : { ok: true, value: {} },
  ),
  on: vi.fn(() => () => {}),
}))
vi.mock('@mantine/notifications', () => ({ notifications: { show, hide } }))

import type { AgentSettingKey } from '@evaos/contract'
import { accessActions, actorOf, readSettings, writeSetting } from './access'
import { THEME_PRESETS, themeStore } from '../theme/theme-config'
import { settingsStore } from '../settings/settings-store'
import { appLinkPlace } from '../navigation/open-link'

const set = (key: string, value: unknown, scope?: string) =>
  writeSetting({ key: key as AgentSettingKey, value, ...(scope ? { scope } : {}) })

beforeEach(() => {
  show.mockClear()
  hide.mockClear()
  themeStore.setState({
    present: THEME_PRESETS[0]!.config,
    preset: THEME_PRESETS[0]!.value,
    past: [],
    future: [],
    themes: [],
    colorScheme: 'light',
  })
})

describe('settings.set', () => {
  it('switches the theme by name, tells Isaac who did it with Undo, and undoes it', async () => {
    const r = await set('theme.preset', 'Ocean', 'agent:nova')
    expect(r).toMatchObject({
      key: 'theme.preset',
      value: 'ocean',
      previous: 'default',
      changed: true,
    })
    expect(themeStore.getState().preset).toBe('ocean')
    // What notifications.show got: the toast's id and its message element.
    const toast: { id: string; message: ReactNode } = show.mock.calls.at(-1)![0]
    expect(toast.id).toBe(`agent-change-${'changeId' in r ? r.changeId : ''}`)
    // The toast's text: "Nova changed theme to Ocean" with an Undo button.
    render(<MantineProvider env="test">{toast.message}</MantineProvider>)
    expect(screen.getByTestId('agent-change-toast').textContent).toBe(
      'Nova changed theme to Ocean·Undo',
    )
    fireEvent.click(screen.getByTestId('agent-change-undo'))
    await vi.waitFor(() => expect(themeStore.getState().preset).toBe('default'))
    expect(hide).toHaveBeenCalledWith(toast.id)
  })

  it('undoes the latest change through settings.undo, and refuses when nothing is left', async () => {
    await set('theme.mode', 'dark')
    await set('theme.colors.dark.body', '#102027')
    expect(themeStore.getState().present.semantic.dark.body).toBe('#102027')
    expect(await accessActions['settings.undo']({})).toMatchObject({
      key: 'theme.colors.dark.body',
      value: '#1a1b1e',
    })
    expect(themeStore.getState().present.semantic.dark.body).toBe('#1a1b1e')
    expect(await accessActions['settings.undo']({})).toMatchObject({
      key: 'theme.mode',
      value: 'light',
    })
    expect(themeStore.getState().colorScheme).toBe('light')
    await expect(accessActions['settings.undo']({})).rejects.toMatchObject({ code: 'not-found' })
  })

  it('refuses a theme that does not exist, listing the ones that do, and changes nothing', async () => {
    await expect(set('theme.preset', 'Sepia')).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('Ocean (ocean)'),
    })
    await expect(set('theme.colors.dark.body', 'red')).rejects.toMatchObject({
      code: 'invalid-params',
    })
    expect(themeStore.getState().preset).toBe('default')
    expect(show).not.toHaveBeenCalled()
  })

  it('reports an unchanged value without a toast, and saves chat settings', async () => {
    expect(await set('theme.mode', 'light')).toMatchObject({ changed: false })
    expect(show).not.toHaveBeenCalled()
    await set('chat.showThinking', true)
    expect(settingsStore.getState().show_thinking).toBe(true)
  })

  it('reads every setting with its options and deep link', async () => {
    const { settings } = await readSettings({ section: 'Theme' })
    const preset = settings.find((s) => s.key === 'theme.preset')!
    expect(preset).toMatchObject({
      value: 'default',
      link: 'relay://open/settings/theme?setting=theme.preset',
    })
    expect(preset.options).toContain('ocean (Ocean)')
    expect(settings.every((s) => s.section === 'Theme')).toBe(true)
    expect(actorOf('agent:nova')).toBe('Nova')
    expect(actorOf('/x/session.jsonl')).toBe('Eva')
  })
})

describe('deep links', () => {
  it('open the place the link action built', () => {
    const cases: Array<[object, ReturnType<typeof placeOf>]> = [
      [{ connection: 'github' }, placeOf('settings', { settingsSection: 'Connections' })],
      [{ setting: 'chat.harness' }, placeOf('settings', { settingsSection: 'Chat' })],
      [{ page: 'jobs' }, placeOf('jobs')],
      [{ page: 'agent:nova' }, placeOf('agent:nova')],
      [{ page: 'workspace:ecard' }, placeOf('workspace:ecard')],
      [{ page: 'canvas', canvas: 'artifacts' }, placeOf('canvas', { canvas: 'artifacts' })],
      [{ page: 'reviews', item: 'https://github.com/o/r/pull/1' }, placeOf('reviews')],
    ]
    for (const [params, place] of cases) {
      const { url } = appLinkFor(AgentLinkParamsSchema.parse(params))
      expect(appLinkPlace(parseAppLink(url)!), url).toEqual(place)
    }
    expect(appLinkPlace(parseAppLink('relay://open/settings/nope')!)).toBeNull()
    expect(appLinkPlace(parseAppLink('relay://open/jobs/x')!)).toBeNull()
  })
})
