import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOf } from '@evaos/shell-core'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => undefined }))
vi.mock('@mantine/notifications', () => ({ notifications: { show: vi.fn() } }))

import { SettingsPage } from './SettingsPage'
import { assistantsStore } from '../assistants/assistants-store'
import { resetNotificationPrefsForTests } from '../notifications/notifications-store'
import { resetSettingsForTest } from './settings-store'

let saved = { enabled: true, muted: [] as string[] }
let shown = true

beforeEach(() => {
  invoke.mockReset()
  saved = { enabled: true, muted: [] }
  shown = true
  resetSettingsForTest()
  resetNotificationPrefsForTests()
  assistantsStore.setState({
    data: {
      relayUp: true,
      agents: ['nova', 'astra'].map((id) => ({
        id,
        title: id === 'nova' ? 'Nova' : 'Astra',
        scope: '',
        avatar: { style: 'notionists' as const, seed: id },
        status: 'idle' as const,
        tool: null,
        file: null,
        reply: null,
      })),
    },
  })
  invoke.mockImplementation(async (c: string, input: Record<string, unknown>) => {
    if (c === 'notifications.get') return { ok: true, value: saved }
    if (c === 'notifications.set') {
      saved = { ...saved, ...input }
      return { ok: true, value: saved }
    }
    if (c === 'notifications.test') return { ok: true, value: { shown } }
    return { ok: true, value: {} }
  })
})

const open = () =>
  render(
    <MantineProvider env="test">
      <SettingsPage place={placeOf('settings', { settingsSection: 'Notifications' })} />
    </MantineProvider>,
  )

describe('Settings > Notifications', () => {
  it('switches the whole thing off and back on, saving each change', async () => {
    open()
    const sw = await screen.findByTestId('settings-notifications-enabled')
    await waitFor(() => expect(sw).toBeChecked())
    await userEvent.click(sw)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('notifications.set', { enabled: false }),
    )
    expect(sw).not.toBeChecked()
    expect(screen.getByTestId('settings-notifications-assistant-nova')).toBeDisabled()
    await userEvent.click(sw)
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('notifications.set', { enabled: true }),
    )
  })

  it('mutes one assistant and unmutes it', async () => {
    open()
    const nova = await screen.findByTestId('settings-notifications-assistant-nova')
    const astra = screen.getByTestId('settings-notifications-assistant-astra')
    await waitFor(() => expect(nova).toBeChecked())
    await userEvent.click(nova)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('notifications.set', { muted: ['nova'] }),
    )
    expect(nova).not.toBeChecked()
    expect(astra).toBeChecked()
    await userEvent.click(nova)
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('notifications.set', { muted: [] }))
  })

  it('sends a test and says whether this copy can show one', async () => {
    open()
    await userEvent.click(await screen.findByTestId('settings-notifications-test'))
    await waitFor(() =>
      expect(screen.getByTestId('settings-notifications-test-result')).toHaveTextContent(/Sent/),
    )
    shown = false
    await userEvent.click(screen.getByTestId('settings-notifications-test'))
    await waitFor(() =>
      expect(screen.getByTestId('settings-notifications-test-result')).toHaveTextContent(
        'cannot show notifications',
      ),
    )
  })
})
