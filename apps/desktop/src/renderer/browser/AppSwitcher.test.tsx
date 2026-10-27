import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SwitchApp, TabState } from '@evaos/contract'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { AppSwitcher } from './AppSwitcher'

const app = (id: string, over: Partial<SwitchApp> = {}): SwitchApp => ({
  id,
  ticket: `ENG-${id.length}000`,
  title: `${id} title`,
  branch: `feat/${id}`,
  port: 3000 + id.length,
  worktree: `work/${id}`,
  api: 'dev',
  running: true,
  active: false,
  ...over,
})

const tab = (over: Partial<TabState> = {}): TabState => ({
  id: 't1',
  url: 'https://localhost:3001/reports',
  title: 'Reports',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  blank: false,
  error: null,
  favicon: null,
  pinned: false,
  ...over,
})

const ui = (t: TabState) =>
  render(
    <MantineProvider>
      <AppSwitcher tab={t} />
    </MantineProvider>,
  )

let apps: SwitchApp[]

beforeEach(() => {
  apps = [
    app('rbac', { ticket: 'ENG-6476', active: true }),
    app('assets', { ticket: 'ENG-6406' }),
    app('scratch', { ticket: null, branch: null, running: false }),
  ]
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, input: { id?: string }) => {
    if (channel === 'browser.switchApps') return { ok: true, value: { apps } }
    if (channel === 'browser.switchApp') return { ok: true, value: { active: input.id } }
    return { ok: true, value: {} }
  })
})

describe('AppSwitcher', () => {
  it("names the active app's ticket on the toolbar button", async () => {
    ui(tab())
    await waitFor(() => expect(screen.getByTestId('app-switch')).toHaveTextContent('ENG-6476'))
    expect(screen.getByTestId('app-switch')).toHaveAttribute(
      'aria-label',
      'Local eCard app: ENG-6476',
    )
  })

  it('lists every app with its ticket, title, branch, port and labelled state', async () => {
    ui(tab())
    await waitFor(() => expect(screen.getByTestId('app-switch')).toHaveTextContent('ENG-6476'))
    fireEvent.click(screen.getByTestId('app-switch'))
    const rbac = await screen.findByTestId('app-switch-item-rbac')
    expect(rbac).toHaveAttribute('aria-current', 'true')
    expect(rbac).toHaveTextContent('ENG-6476')
    expect(rbac).toHaveTextContent('rbac title')
    expect(rbac).toHaveTextContent('feat/rbac')
    expect(rbac).toHaveTextContent(':3004')
    expect(within(rbac).getByText('Active')).toBeInTheDocument()
    expect(within(rbac).getByText('Running')).toBeInTheDocument()
    const scratch = screen.getByTestId('app-switch-item-scratch')
    expect(scratch).not.toHaveAttribute('aria-current')
    expect(scratch).toHaveTextContent('scratch')
    expect(scratch).toHaveTextContent('Detached HEAD')
    expect(within(scratch).getByText('Stopped')).toBeInTheDocument()
    expect(within(scratch).queryByText('Active')).toBeNull()
  })

  it('switches through main and shows the new app at once', async () => {
    ui(tab())
    await waitFor(() => expect(screen.getByTestId('app-switch')).toHaveTextContent('ENG-6476'))
    fireEvent.click(screen.getByTestId('app-switch'))
    fireEvent.click(await screen.findByTestId('app-switch-item-assets'))
    await waitFor(() => expect(screen.getByTestId('app-switch')).toHaveTextContent('ENG-6406'))
    expect(invoke).toHaveBeenCalledWith('browser.switchApp', { tabId: 't1', id: 'assets' })
  })

  it('does nothing when the active app is picked again', async () => {
    ui(tab())
    await waitFor(() => expect(screen.getByTestId('app-switch')).toHaveTextContent('ENG-6476'))
    fireEvent.click(screen.getByTestId('app-switch'))
    fireEvent.click(await screen.findByTestId('app-switch-item-rbac'))
    expect(invoke).not.toHaveBeenCalledWith('browser.switchApp', expect.anything())
  })

  it('rereads the list when a page load finishes', async () => {
    const r = ui(tab({ loading: true }))
    expect(invoke).not.toHaveBeenCalled()
    r.rerender(
      <MantineProvider>
        <AppSwitcher tab={tab({ loading: false })} />
      </MantineProvider>,
    )
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser.switchApps', { tabId: 't1' }))
  })

  it('explains a switch that is not answering', async () => {
    invoke.mockResolvedValue({
      ok: false,
      error: {
        code: 'app-switch-down',
        message: 'The app switch on https://localhost:3001 is not answering.',
      },
    })
    ui(tab())
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId('app-switch'))
    await waitFor(() =>
      expect(screen.getByTestId('app-switch-menu')).toHaveTextContent('is not answering'),
    )
    expect(screen.getByTestId('app-switch')).toHaveTextContent('Apps')
  })
})
