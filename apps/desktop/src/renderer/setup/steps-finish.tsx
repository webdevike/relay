import { Alert, Button, CopyButton, Group, List, Progress, Stack, Text } from '@mantine/core'
import { IconCheck, IconMinus, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { placeOf } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { flushPendingTabs } from '../tabs/tabs-store'
import { useSetupRun } from './run'
import { QrCode } from './QrCode'
import type { WizardCtx } from './wizard'

export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/hjsTe54Y'
export const TAILSCALE_IOS_URL = 'https://apps.apple.com/app/tailscale/id1470499037'
const DEFAULT_PORT = 7817

export function PhoneStep({ ctx }: { ctx: WizardCtx }) {
  const [openError, setOpenError] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const install = useSetupRun()
  const t = ctx.detect?.tailscale
  const ready = t?.installed === true && t.loggedIn && !!t.tailnetIp
  const recheck = useRef(ctx.recheck)
  recheck.current = ctx.recheck

  // The user asked for Tailscale here, so its macOS approval dialogs are expected. Once the install finished
  // (the pkg starts the app) or the user opened it, recheck live until signed in or the step unmounts.
  const engaged = opened || install.view.status === 'ok'
  useEffect(() => {
    if (!engaged || ready) return
    const id = setInterval(() => void recheck.current(), 3000)
    return () => clearInterval(id)
  }, [engaged, ready])

  const installTailscale = (): void => {
    void install.start({ task: 'install', tool: 'tailscale' }).then(() => void recheck.current())
  }

  const port = ctx.detect?.relayHost.port ?? DEFAULT_PORT
  const address = t?.tailnetIp ? `${t.tailnetIp}:${port}` : null

  return (
    <Stack gap="md" data-testid="setup-phone">
      <Group
        gap="sm"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          background: 'var(--mantine-color-body)',
          padding: '6px 0',
        }}
      >
        <Button
          onClick={ctx.finish}
          data-testid="setup-phone-next"
          variant={ready ? 'filled' : 'default'}
        >
          {ready ? 'Continue' : 'Skip for now'}
        </Button>
        <Button variant="subtle" onClick={ctx.back}>
          Back
        </Button>
      </Group>
      <Text c="dimmed" size="sm">
        Your iPhone reaches this Mac through Tailscale, a private network only your devices are on.
        You can skip this and pair later from Settings, Setup.
      </Text>

      <div className="eva-settings-card eva-settings-card-pad">
        <Text fw={600}>1. Tailscale on this Mac</Text>
        {ready ? (
          <Group gap={6} mt={4} data-testid="setup-tailscale-ok">
            <IconCheck size={16} color="var(--mantine-color-green-6)" />
            <Text size="sm">Signed in{t?.tailnetIp ? ` as ${t.tailnetIp}` : ''}</Text>
          </Group>
        ) : !t?.installed ? (
          <Stack gap="xs" mt={4} data-testid="setup-tailscale-install">
            <Text size="sm">Set up Tailscale (lets your iPhone reach this Mac)</Text>
            <Group>
              <Button
                size="xs"
                loading={install.view.status === 'running'}
                onClick={installTailscale}
                data-testid="setup-install-tailscale"
              >
                {install.view.status === 'err' ? 'Try again' : 'Install Tailscale'}
              </Button>
              <Text size="xs" c="dimmed">
                macOS will ask to allow a VPN configuration: click Allow.
              </Text>
            </Group>
            {install.view.status === 'running' ? (
              <div>
                <Progress value={install.view.percent} size="sm" />
                <Text size="xs" c="dimmed" mt={4}>
                  {install.view.line}
                </Text>
              </div>
            ) : null}
            {install.view.status === 'err' ? (
              <Text size="xs" c="red">
                {install.view.message || 'Could not install Tailscale.'}
              </Text>
            ) : null}
          </Stack>
        ) : (
          <Stack gap="xs" mt={4}>
            <Group gap={6}>
              <IconX size={16} color="var(--mantine-color-red-6)" />
              <Text size="sm">Not signed in yet.</Text>
            </Group>
            <Group>
              <Button
                size="xs"
                data-testid="setup-open-tailscale"
                onClick={() =>
                  void invoke('setup.openTailscale', {}).then((r) => {
                    setOpenError(r.ok ? null : r.error.message)
                    if (r.ok) setOpened(true)
                  })
                }
              >
                {opened ? 'Open Tailscale again' : 'Open Tailscale'}
              </Button>
              <Text size="xs" c="dimmed">
                {engaged
                  ? 'Sign in there, then come back. This page checks on its own.'
                  : 'macOS will ask you to approve a VPN configuration the first time.'}
              </Text>
            </Group>
            {openError ? (
              <Text size="xs" c="red">
                {openError}
              </Text>
            ) : null}
          </Stack>
        )}
      </div>

      <div className="eva-settings-card eva-settings-card-pad">
        <Text fw={600}>2. Two apps on your iPhone</Text>
        <Text size="sm" c="dimmed" mb="sm">
          Point the camera at each code. Sign in to the same Tailscale account as the Mac.
        </Text>
        <Group gap="xl">
          <QrCode
            value={TESTFLIGHT_URL}
            caption="Relay (TestFlight)"
            testid="setup-qr-testflight"
          />
          <QrCode
            value={TAILSCALE_IOS_URL}
            caption="Tailscale (App Store)"
            testid="setup-qr-tailscale"
          />
        </Group>
      </div>

      <div className="eva-settings-card eva-settings-card-pad">
        <Text fw={600}>3. Add this Mac in Relay</Text>
        {address ? (
          <Group gap="md" mt="xs" align="center">
            <Text className="eva-setup-address" data-testid="setup-address">
              {address}
            </Text>
            <CopyButton value={address}>
              {({ copied, copy }) => (
                <Button size="xs" variant="default" onClick={copy} data-testid="setup-copy-address">
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
            </CopyButton>
          </Group>
        ) : (
          <Text size="sm" c="dimmed" mt={4}>
            The address shows up here once Tailscale is signed in.
          </Text>
        )}
        <List size="sm" mt="sm" type="ordered" c="dimmed">
          <List.Item>Open Relay on your iPhone.</List.Item>
          <List.Item>Go to Settings, then Computers, then Add by address.</List.Item>
          <List.Item>Paste the address above and confirm.</List.Item>
        </List>
      </div>
    </Stack>
  )
}

interface Check {
  label: string
  ok: boolean
  detail: string
  /** Not set up is fine: shown neutral, never as a failure. */
  optional?: boolean
}

export function DoneStep({ ctx }: { ctx: WizardCtx }) {
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const root = ctx.state.root ?? ctx.defaultRoot

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [d, h] = await Promise.all([ctx.recheck(), invoke('setup.health', { root })])
      if (cancelled) return
      const hostUp = h.ok && h.value.hostPort !== null
      const assistants = h.ok ? h.value.assistants : 0
      setChecks([
        { label: 'omp is installed', ok: d?.omp.installed === true, detail: d?.omp.version ?? '' },
        {
          label: 'Signed in to AI',
          ok: d?.omp.loggedIn === true,
          detail: d?.omp.loggedIn ? '' : 'Sign in from Settings, Setup, or in the first chat.',
        },
        {
          label: 'Relay Host is running',
          ok: hostUp,
          detail: hostUp
            ? `Port ${h.ok ? h.value.hostPort : ''}`
            : 'Your iPhone will not connect until it runs.',
        },
        {
          label: 'Your assistants are ready',
          ok: assistants > 0,
          detail: `${assistants} in ${root}`,
        },
        {
          label: 'Tailscale (iPhone away from home Wi-Fi)',
          ok: d?.tailscale.installed === true && d.tailscale.loggedIn,
          optional: true,
          detail:
            d?.tailscale.installed === true && d.tailscale.loggedIn
              ? (d.tailscale.tailnetIp ?? 'Signed in')
              : 'not set up (optional: needed for iPhone away from home Wi-Fi). Run setup again from Settings, Setup, to add it later.',
        },
      ])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const open = async (): Promise<void> => {
    setError(null)
    setFinishing(true)
    // The tab that was the wizard becomes Assistants, so the relaunched app lands there.
    openPlace(placeOf('assistants'))
    flushPendingTabs()
    if (ctx.rerun) {
      ctx.finish()
      return
    }
    const r = await invoke('setup.complete', {
      root,
      profile: 'starter',
      hostName: ctx.state.hostName ?? ctx.computerName,
    })
    if (!r.ok) {
      setError(r.error.message)
      setFinishing(false)
    }
  }

  return (
    <Stack gap="md" data-testid="setup-done">
      <Text>
        {ctx.rerun
          ? 'Everything was checked again. Nothing was deleted or replaced.'
          : 'Almost there. One last look, then Relay opens with your assistants.'}
      </Text>
      <div className="eva-settings-card">
        {(checks ?? []).map((c) => (
          <div
            key={c.label}
            className="eva-settings-row eva-settings-row-static eva-setup-check-row"
            data-testid="setup-health"
          >
            <span className="eva-setup-icon" data-ok={String(c.ok)} data-optional={String(!!c.optional)}>
              {c.ok ? <IconCheck size={16} /> : c.optional ? <IconMinus size={16} /> : <IconX size={16} />}
            </span>
            <span className="eva-settings-label">
              <span className="eva-settings-label-title">{c.label}</span>
              {c.detail ? <span className="eva-settings-label-help">{c.detail}</span> : null}
            </span>
          </div>
        ))}
      </div>
      {error ? (
        <Alert color="red" title="Could not finish setup">
          {error}
        </Alert>
      ) : null}
      <Group>
        <Button
          onClick={() => void open()}
          loading={finishing}
          disabled={checks === null}
          data-testid="setup-finish"
        >
          {ctx.rerun ? 'Done' : 'Open Relay'}
        </Button>
        <Button variant="subtle" onClick={ctx.back} disabled={finishing}>
          Back
        </Button>
      </Group>
    </Stack>
  )
}
