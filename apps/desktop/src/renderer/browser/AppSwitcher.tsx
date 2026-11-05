import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Loader, Tooltip, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconAlertTriangle, IconChevronDown, IconStack2 } from '@tabler/icons-react'
import type { SwitchApp, TabState } from '@evaos/contract'
import { invoke } from '../ipc'
import { EvaMenu } from '../overlay'

type Loaded =
  | { state: 'loading' }
  | { state: 'ok'; apps: SwitchApp[] }
  | { state: 'error'; message: string }

/**
 * The local eCard app switch (https://localhost:3001) as a toolbar menu: which worktree this tab
 * shows, and every registered app to switch it to. Each tab has its own app; switching reloads
 * only this tab. Mount it keyed by tab id, so another tab never shows this one's list.
 */
export function AppSwitcher({ tab }: { tab: TabState }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [opened, setOpened] = useState(false)
  const [switching, setSwitching] = useState(false)
  const seq = useRef(0)
  const tabId = tab.id
  const load = useCallback(() => {
    const n = ++seq.current
    void invoke('browser.switchApps', { tabId }).then((r) => {
      if (n !== seq.current) return
      setLoaded(
        r.ok ? { state: 'ok', apps: r.value.apps } : { state: 'error', message: r.error.message },
      )
    })
  }, [tabId])
  // Each finished page load rereads the list: a switch reloads the tab, and apps start and stop.
  const pageLoading = tab.loading
  useEffect(() => {
    if (!pageLoading) load()
  }, [pageLoading, load])

  const select = async (app: SwitchApp): Promise<void> => {
    setOpened(false)
    if (app.active) return
    setSwitching(true)
    const r = await invoke('browser.switchApp', { tabId: tab.id, id: app.id })
    setSwitching(false)
    if (!r.ok) {
      notifications.show({
        color: 'red',
        message: `Could not switch to ${app.ticket ?? app.id}: ${r.error.message}`,
        autoClose: 8000,
      })
      return
    }
    // The reload's own refresh confirms this; until then the menu already shows the new app.
    seq.current++
    setLoaded((prev) =>
      prev.state === 'ok'
        ? { state: 'ok', apps: prev.apps.map((a) => ({ ...a, active: a.id === r.value.active })) }
        : prev,
    )
  }

  const active = loaded.state === 'ok' ? loaded.apps.find((a) => a.active) : undefined
  const hint =
    loaded.state === 'error'
      ? loaded.message
      : active
        ? `${active.title}, ${active.branch ?? 'detached HEAD'} on :${active.port}`
        : 'Local eCard apps'

  return (
    <EvaMenu
      opened={opened}
      onChange={(o) => {
        setOpened(o)
        if (o) load()
      }}
      width={420}
      position="bottom-end"
    >
      <EvaMenu.Target>
        <Tooltip label={hint} openDelay={400} disabled={opened} multiline maw={360}>
          <UnstyledButton
            className="eva-app-switch"
            aria-label={
              active ? `Local eCard app: ${active.ticket ?? active.id}` : 'Local eCard apps'
            }
            data-testid="app-switch"
          >
            {switching || loaded.state === 'loading' ? (
              <Loader size={12} />
            ) : loaded.state === 'error' ? (
              <IconAlertTriangle size={16} stroke={1.75} />
            ) : (
              <IconStack2 size={16} stroke={1.75} />
            )}
            <span className="eva-app-switch-label">
              {active ? (active.ticket ?? active.id) : 'Apps'}
            </span>
            <IconChevronDown size={14} stroke={1.75} />
          </UnstyledButton>
        </Tooltip>
      </EvaMenu.Target>
      <EvaMenu.Dropdown data-testid="app-switch-menu">
        {loaded.state === 'error' ? (
          <div className="eva-app-switch-note">{loaded.message}</div>
        ) : loaded.state === 'loading' ? (
          <div className="eva-app-switch-note">Loading apps</div>
        ) : loaded.apps.length === 0 ? (
          <div className="eva-app-switch-note">
            No apps registered. Add one with bun work/ecard-app-switch.ts add.
          </div>
        ) : (
          <>
            <EvaMenu.Label>Local eCard apps on localhost:3001</EvaMenu.Label>
            {loaded.apps.map((a) => (
              <EvaMenu.Item
                key={a.id}
                data-testid={`app-switch-item-${a.id}`}
                aria-current={a.active ? 'true' : undefined}
                classNames={{ itemLabel: 'eva-app-switch-item-label' }}
                onClick={() => void select(a)}
                rightSection={
                  <span className="eva-app-switch-states">
                    {a.active ? (
                      <Badge size="xs" variant="light" radius="sm" tt="none" color="blue">
                        Active
                      </Badge>
                    ) : null}
                    <Badge
                      size="xs"
                      variant="light"
                      radius="sm"
                      tt="none"
                      color={a.running ? 'green' : 'gray'}
                    >
                      {a.running ? 'Running' : 'Stopped'}
                    </Badge>
                  </span>
                }
              >
                <span className="eva-app-switch-head">
                  <span className="eva-app-switch-key">{a.ticket ?? a.id}</span>
                  <span className="eva-app-switch-title" title={a.title}>
                    {a.title}
                  </span>
                </span>
                <span className="eva-app-switch-meta">
                  <span className="eva-app-switch-branch" title={a.branch ?? undefined}>
                    {a.branch ?? 'Detached HEAD'}
                  </span>
                  <span>:{a.port}</span>
                </span>
              </EvaMenu.Item>
            ))}
          </>
        )}
      </EvaMenu.Dropdown>
    </EvaMenu>
  )
}
