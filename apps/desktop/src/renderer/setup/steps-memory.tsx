import {
  Alert,
  Anchor,
  Button,
  Group,
  PasswordInput,
  Progress,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import type { HindsightStatus, SetupProvider } from '@evaos/contract'
import { invoke } from '../ipc'
import { memoryPhase } from './hindsight-state'
import { useSetupRun } from './run'
import type { WizardCtx } from './wizard'

const DOCKER_URL = 'https://www.docker.com/products/docker-desktop/'
const ORBSTACK_URL = 'https://orbstack.dev/download'

/** Docker/container state, refreshed on demand and after every run. */
function useMemoryStatus(): {
  status: HindsightStatus | null
  error: string | null
  refresh(): Promise<void>
} {
  const [status, setStatus] = useState<HindsightStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    const r = await invoke('setup.hindsight.status', {})
    if (r.ok) {
      setStatus(r.value)
      setError(null)
    } else {
      setError(r.error.message)
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { status, error, refresh }
}

function DockerHelp({ missing }: { missing: boolean }) {
  return (
    <Alert
      color="yellow"
      title={missing ? 'Docker is not installed' : 'Docker is not running'}
      data-testid="memory-docker"
    >
      {missing ? (
        <>
          Long-term memory runs in Docker. Install{' '}
          <Anchor href={DOCKER_URL} target="_blank">
            Docker Desktop
          </Anchor>{' '}
          or{' '}
          <Anchor href={ORBSTACK_URL} target="_blank">
            OrbStack
          </Anchor>
          , open it once, then check again. Relay never installs it for you.
        </>
      ) : (
        <>
          Docker is installed but not answering. Open Docker (or OrbStack), wait for it to start,
          then check again.
        </>
      )}
    </Alert>
  )
}

/** The controls shared by the wizard step and Settings. */
function MemoryControls({
  root,
  userName,
  onChanged,
  settings,
}: {
  root: string
  userName: string | undefined
  onChanged?: () => void
  settings: boolean
}) {
  const { status, error, refresh } = useMemoryStatus()
  const run = useSetupRun()
  const [key, setKey] = useState('')
  const [provider, setProvider] = useState<SetupProvider>('openai')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const phase = memoryPhase(status)
  const busy = run.view.status === 'running'

  const go = async (action: 'install' | 'disable' | 'remove'): Promise<void> => {
    setConfirmRemove(false)
    const out = await run.start({
      task: 'hindsight',
      action,
      root,
      ...(userName ? { userName } : {}),
      ...(action === 'install' && key.trim() ? { key: key.trim(), keyProvider: provider } : {}),
    })
    setKey('')
    await refresh()
    if (out.ok) onChanged?.()
  }

  return (
    <Stack gap="md" data-testid="memory-controls" data-phase={phase}>
      {error ? <Alert color="red">{error}</Alert> : null}
      {phase === 'checking' ? (
        <Text c="dimmed" size="sm">
          Checking Docker…
        </Text>
      ) : null}
      {phase === 'docker-missing' || phase === 'docker-down' ? (
        <DockerHelp missing={phase === 'docker-missing'} />
      ) : null}
      {phase === 'needs-key' ? (
        <Stack gap="xs" data-testid="memory-key">
          <Text size="sm" c="dimmed">
            Memory reads your conversations with an AI model. Paste an API key for it. It stays on
            this Mac, in a private file.
          </Text>
          <SegmentedControl
            size="xs"
            value={provider}
            onChange={(v) => setProvider(v as SetupProvider)}
            data={[
              { value: 'openai', label: 'OpenAI' },
              { value: 'anthropic', label: 'Anthropic' },
            ]}
          />
          <PasswordInput
            label="API key"
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            data-testid="memory-key-input"
          />
        </Stack>
      ) : null}
      {phase === 'on' && status ? (
        <Alert color="green" title="Long-term memory is on" data-testid="memory-ok">
          Your assistant saves what matters and recalls it next time. It lives at {status.apiUrl},
          only on this Mac, in the bank "{status.bankId}".
        </Alert>
      ) : null}
      {phase === 'repair' ? (
        <Alert color="yellow" title="Memory is set up but not running" data-testid="memory-repair">
          Press Set up to start it again and reconnect your assistant. Your saved memories are kept.
        </Alert>
      ) : null}
      {busy ? (
        <>
          <Progress value={run.view.percent} size="sm" />
          <Text size="xs" c="dimmed" data-testid="memory-line">
            {run.view.line}
          </Text>
        </>
      ) : null}
      {run.view.status === 'err' ? (
        <Alert color="red" title="That did not work" data-testid="memory-error">
          {run.view.message}
        </Alert>
      ) : null}
      {(phase === 'ready' || phase === 'needs-key') && !busy ? (
        <Text size="xs" c="dimmed" data-testid="memory-size-note">
          Downloads about 3.5 GB the first time.
        </Text>
      ) : null}
      <Group>
        {phase === 'ready' || phase === 'needs-key' || phase === 'repair' ? (
          <Button
            onClick={() => void go('install')}
            loading={busy}
            disabled={phase === 'needs-key' && key.trim() === ''}
            data-testid="memory-install"
          >
            {run.view.status === 'err' ? 'Try again' : 'Set up'}
          </Button>
        ) : null}
        {phase === 'docker-missing' || phase === 'docker-down' || phase === 'checking' ? (
          <Button variant="default" onClick={() => void refresh()} data-testid="memory-recheck">
            Check again
          </Button>
        ) : null}
        {settings && status && status.container !== 'none' ? (
          <>
            <Button
              variant="default"
              onClick={() => void go('disable')}
              disabled={busy}
              data-testid="memory-disable"
            >
              Turn off
            </Button>
            {confirmRemove ? (
              <Button
                color="red"
                onClick={() => void go('remove')}
                disabled={busy}
                data-testid="memory-remove-confirm"
              >
                Yes, delete my memories
              </Button>
            ) : (
              <Button
                variant="subtle"
                color="red"
                onClick={() => setConfirmRemove(true)}
                disabled={busy}
                data-testid="memory-remove"
              >
                Remove and delete memories
              </Button>
            )}
          </>
        ) : null}
      </Group>
    </Stack>
  )
}

/** Wizard step: optional, skipped unless the user presses Set up. */
export function MemoryStep({ ctx }: { ctx: WizardCtx }) {
  const [ready, setReady] = useState(false)
  return (
    <Stack gap="md" data-testid="setup-memory">
      <Text size="sm">
        Long-term memory lets your assistant remember what you decided and prefer across
        conversations, instead of starting fresh each time.
      </Text>
      <Text c="dimmed" size="sm">
        It runs as a small private service in Docker on this Mac and is never reachable from other
        devices. You can turn it off in Settings any time.
      </Text>
      <MemoryControls
        root={ctx.state.root ?? ctx.defaultRoot}
        userName={ctx.state.userName}
        onChanged={() => setReady(true)}
        settings={false}
      />
      <Group>
        <Button
          onClick={ctx.finish}
          variant={ready ? 'filled' : 'default'}
          data-testid="setup-memory-next"
        >
          {ready ? 'Continue' : 'Skip for now'}
        </Button>
        <Button variant="subtle" onClick={ctx.back} data-testid="setup-memory-back">
          Back
        </Button>
      </Group>
    </Stack>
  )
}

/** Settings, Setup: the same controls plus turn off and remove. */
export function MemorySection({ root, userName }: { root: string; userName?: string }) {
  return (
    <div className="eva-settings-card" data-testid="settings-memory">
      <div className="eva-settings-row eva-settings-row-static">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Long-term memory</span>
          <span className="eva-settings-label-help">
            Your assistant remembers decisions and preferences across conversations. Runs privately
            in Docker on this Mac.
          </span>
        </span>
      </div>
      <div className="eva-settings-row eva-settings-row-static">
        <MemoryControls root={root} userName={userName} settings />
      </div>
    </div>
  )
}
