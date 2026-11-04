import {
  Alert,
  Anchor,
  Button,
  Group,
  Progress,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core'
import { useCallback, useEffect, useState } from 'react'
import type { HindsightStatus } from '@evaos/contract'
import { invoke } from '../ipc'
import { formatBytes, installEngine, memoryPhase, offersDockerFallback } from './hindsight-state'
import { checkMemory } from './memory-watch'
import { useSetupRun } from './run'
import type { WizardCtx } from './wizard'

const DOCKER_URL = 'https://www.docker.com/products/docker-desktop/'
const ORBSTACK_URL = 'https://orbstack.dev/download'

/** Install state, refreshed on demand and after every run. */
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

/** Only shown on an Intel Mac, where Relay's own install cannot run the local models. */
function DockerHelp({ missing }: { missing: boolean }) {
  return (
    <Alert
      color="yellow"
      title={missing ? 'Docker is not installed' : 'Docker is not running'}
      data-testid="memory-docker"
    >
      This Mac has an Intel processor, so long-term memory has to run in Docker.{' '}
      {missing ? (
        <>
          Install{' '}
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
        <>Open Docker (or OrbStack), wait for it to start, then check again.</>
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
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [lastEngine, setLastEngine] = useState<'native' | 'docker' | null>(null)
  const [useLocal, setUseLocal] = useState(true)
  const phase = memoryPhase(status)
  const engine = installEngine(status)
  const busy = run.view.status === 'running'
  const failed = run.view.status === 'err'
  /** The model on this Mac, when this Mac can run it and it is not set up yet. */
  const localOffered = status?.local && !status.local.installed ? status.local : null
  /** Offered up front only on a first install; later it is a Settings button. */
  const offer = status?.engine === 'none' && engine === 'native' ? localOffered : null
  const picksLocal = offer !== null && (status?.llm === 'none' || useLocal)

  const go = async (
    action: 'install' | 'update' | 'restart' | 'relogin' | 'disable' | 'remove',
    o: { engine?: 'native' | 'docker'; local?: boolean } = {},
  ): Promise<void> => {
    setConfirmRemove(false)
    const withEngine = o.engine ?? engine
    if (action === 'install') setLastEngine(withEngine)
    const out = await run.start({
      task: 'hindsight',
      action,
      ...(action === 'install'
        ? { engine: withEngine, ...(o.local ? { llm: 'local' as const } : {}) }
        : {}),
      root,
      ...(userName ? { userName } : {}),
    })
    await refresh()
    void checkMemory()
    if (out.ok) onChanged?.()
  }

  return (
    <Stack gap="md" data-testid="memory-controls" data-phase={phase} data-engine={engine}>
      {error ? <Alert color="red">{error}</Alert> : null}
      {phase === 'checking' ? (
        <Text c="dimmed" size="sm">
          Checking…
        </Text>
      ) : null}
      {phase === 'docker-missing' || phase === 'docker-down' ? (
        <DockerHelp missing={phase === 'docker-missing'} />
      ) : null}
      {phase === 'needs-key' ? (
        <Alert color="yellow" title="Memory needs an AI account" data-testid="memory-key">
          Memory reads your conversations with an AI model. Sign in to ChatGPT or add an AI key in
          the AI step (Settings, Setup), then check again. Keys stay in your private Relay settings,
          never in a chat.
        </Alert>
      ) : null}
      {offer ? (
        <Stack gap="xs" data-testid="memory-local-offer">
          {status?.llm === 'none' ? null : (
            <SegmentedControl
              size="xs"
              value={useLocal ? 'local' : 'account'}
              onChange={(v) => setUseLocal(v === 'local')}
              data={[
                { value: 'local', label: 'A model on this Mac' },
                { value: 'account', label: 'My AI account' },
              ]}
              data-testid="memory-llm-choice"
            />
          )}
          {picksLocal ? (
            <Text size="sm" data-testid="memory-local-cost">
              Memory will read with a model that runs on this Mac, so nothing is sent to an AI
              company and it costs nothing per use. It downloads about{' '}
              {formatBytes(offer.downloadBytes)} and holds about {formatBytes(offer.ramBytes)} of
              memory while it runs.
            </Text>
          ) : null}
        </Stack>
      ) : null}
      {status?.problem ? (
        <Alert color="red" title="Memory isn't saving" data-testid="memory-problem">
          {status.problem.message}
          <Group mt="xs">
            <Button
              size="compact-sm"
              onClick={() => void go(status.problem?.fix === 'sign-in' ? 'relogin' : 'restart')}
              disabled={busy}
              data-testid="memory-fix"
            >
              {status.problem.fix === 'sign-in' ? 'Sign in again' : 'Restart memory'}
            </Button>
          </Group>
        </Alert>
      ) : null}
      {phase === 'on' && !status?.problem && status ? (
        <Alert color="green" title="Long-term memory is on" data-testid="memory-ok">
          Your assistant saves what matters and recalls it next time. It lives at {status.apiUrl},
          only on this Mac, in the bank "{status.bankId}".
          {status.engine === 'native' && status.version ? (
            <Text size="xs" mt={4} data-testid="memory-version">
              Hindsight {status.version}
              {status.diskBytes !== null
                ? `, ${formatBytes(status.diskBytes)} on disk (the program, its models and your memories)`
                : ''}
              . Reads with{' '}
              {status.local?.installed
                ? `the model on this Mac (${status.local.running ? 'running' : 'stopped'})`
                : status.llm === 'codex'
                  ? 'your ChatGPT sign-in'
                  : 'your AI account'}
              .
            </Text>
          ) : null}
          {status.engine === 'docker' ? (
            <Text size="xs" mt={4} data-testid="memory-docker-note">
              Running in Docker.
            </Text>
          ) : null}
        </Alert>
      ) : null}
      {phase === 'repair' && !status?.problem ? (
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
      {failed ? (
        <Alert color="red" title="That did not work" data-testid="memory-error">
          {run.view.message}
        </Alert>
      ) : null}
      {(phase === 'ready' || phase === 'needs-key') && !busy ? (
        <Text size="xs" c="dimmed" data-testid="memory-size-note">
          {engine === 'native'
            ? `Downloads about 2.5 GB the first time and uses about 1 GB of memory while it runs${picksLocal ? ', plus the model' : ''}.`
            : 'Downloads about 3.5 GB the first time.'}
        </Text>
      ) : null}
      <Group>
        {phase === 'ready' || phase === 'repair' ? (
          <Button
            onClick={() => void go('install', { local: picksLocal })}
            loading={busy}
            data-testid="memory-install"
          >
            {failed ? 'Try again' : 'Set up'}
          </Button>
        ) : null}
        {failed && !busy && offersDockerFallback(status, lastEngine) ? (
          <Button
            variant="default"
            onClick={() => void go('install', { engine: 'docker' })}
            data-testid="memory-use-docker"
          >
            Use Docker instead
          </Button>
        ) : null}
        {phase === 'docker-missing' ||
        phase === 'docker-down' ||
        phase === 'needs-key' ||
        phase === 'checking' ? (
          <Button variant="default" onClick={() => void refresh()} data-testid="memory-recheck">
            Check again
          </Button>
        ) : null}
        {settings && status && status.engine !== 'none' ? (
          <>
            {status.engine === 'native' && localOffered ? (
              <Button
                variant="default"
                onClick={() => void go('install', { local: true })}
                disabled={busy}
                data-testid="memory-use-local"
              >
                Use a model on this Mac
              </Button>
            ) : null}
            {status.engine === 'native' ? (
              <Button
                variant="default"
                onClick={() => void go('update')}
                disabled={busy}
                data-testid="memory-update"
              >
                Update
              </Button>
            ) : null}
            {status.service === 'running' ? (
              <Button
                variant="default"
                onClick={() => void go('disable')}
                disabled={busy}
                data-testid="memory-disable"
              >
                Turn off
              </Button>
            ) : null}
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
        Relay installs it for you as a small private service on this Mac. It is never reachable from
        other devices, and you can update or remove it in Settings any time.
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

/** Settings, Setup: the same controls plus update, turn off and remove. */
export function MemorySection({ root, userName }: { root: string; userName?: string }) {
  return (
    <div className="eva-settings-card" data-testid="settings-memory">
      <div className="eva-settings-row eva-settings-row-static">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Long-term memory</span>
          <span className="eva-settings-label-help">
            Your assistant remembers decisions and preferences across conversations. Runs privately
            on this Mac, managed by Relay.
          </span>
        </span>
      </div>
      <div className="eva-settings-row eva-settings-row-static">
        <MemoryControls root={root} userName={userName} settings />
      </div>
    </div>
  )
}
