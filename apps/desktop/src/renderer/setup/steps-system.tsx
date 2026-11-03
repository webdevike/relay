import {
  Alert,
  Badge,
  Button,
  Group,
  PasswordInput,
  Progress,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core'
import { IconCheck, IconCircleDashed, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import type { SetupProvider } from '@evaos/contract'
import { TOOL_LABEL, missingTools, runSetup, useSetupRun } from './run'
import type { WizardCtx } from './wizard'

export function WelcomeStep({ ctx }: { ctx: WizardCtx }) {
  return (
    <Stack gap="md" data-testid="setup-welcome">
      <Text>
        Relay is where you chat with your AI assistants on your Mac and your iPhone. This setup gets
        your Mac ready, signs you in to an AI provider, creates a folder that holds everything your
        assistants know, and links your phone.
      </Text>
      <Text c="dimmed" size="sm">
        Here is what will happen: check which tools you already have, install the missing ones, sign
        in to AI, create your home base folder and assistants, start Relay Host, and pair your
        iPhone. Nothing is changed without showing you first, and nothing you already have is
        replaced or deleted. macOS may ask for your password for a few installs; you type it into
        macOS, never into Relay.
      </Text>
      <Group>
        <Button onClick={ctx.finish} data-testid="setup-start">
          Get started
        </Button>
      </Group>
    </Stack>
  )
}

function Status({ ok, label, detail }: { ok: boolean | 'warn'; label: string; detail: string }) {
  return (
    <div
      className="eva-settings-row eva-settings-row-static eva-setup-check-row"
      data-testid={`setup-tool-${label}`}
    >
      <span className="eva-setup-icon" data-ok={String(ok)}>
        {ok === true ? (
          <IconCheck size={16} />
        ) : ok === 'warn' ? (
          <IconCircleDashed size={16} />
        ) : (
          <IconX size={16} />
        )}
      </span>
      <span className="eva-settings-label">
        <span className="eva-settings-label-title">{TOOL_LABEL[label] ?? label}</span>
        <span className="eva-settings-label-help">{detail}</span>
      </span>
    </div>
  )
}

export function CheckStep({ ctx }: { ctx: WizardCtx }) {
  const [busy, setBusy] = useState(false)
  const started = useRef(false)
  const d = ctx.detect
  useEffect(() => {
    if (started.current) return
    started.current = true
    setBusy(true)
    void ctx.recheck().finally(() => setBusy(false))
  }, [ctx])
  const missing = d ? missingTools(d) : []
  const ver = (
    t: { installed: boolean; version?: string | null },
    fallback = 'Missing, will be installed',
  ) => (t.installed ? `Installed${t.version ? ` (${t.version})` : ''}` : fallback)
  return (
    <Stack gap="md" data-testid="setup-check">
      <Text c="dimmed" size="sm">
        Looking at your Mac. Nothing is changed in this step.
      </Text>
      {ctx.detectError ? (
        <Alert color="red" title="Could not check your Mac" data-testid="setup-detect-error">
          {ctx.detectError}
        </Alert>
      ) : null}
      {d ? (
        <div className="eva-settings-card">
          <Status ok={d.clt.installed} label="clt" detail={ver(d.clt)} />
          <Status ok={d.brew.installed} label="brew" detail={ver(d.brew)} />
          <Status ok={d.bun.installed} label="bun" detail={ver(d.bun)} />
          <Status
            ok={d.omp.installed ? (d.omp.loggedIn ? true : 'warn') : false}
            label="omp"
            detail={
              d.omp.installed
                ? `${ver(d.omp)}${d.omp.loggedIn ? ', signed in' : ', needs sign-in (next steps)'}`
                : ver(d.omp)
            }
          />
          <Status ok={d.herdr.installed} label="herdr" detail={ver(d.herdr)} />
          <Status
            ok={d.tailscale.installed && d.tailscale.loggedIn ? true : 'warn'}
            label="tailscale"
            detail={
              d.tailscale.installed
                ? `${ver(d.tailscale)}${d.tailscale.loggedIn ? ', signed in' : ', needs sign-in (later)'}`
                : 'Not installed (optional, set up later on the iPhone step)'
            }
          />
        </div>
      ) : (
        <Text size="sm">{busy ? 'Checking…' : ''}</Text>
      )}
      <Group>
        <Button onClick={ctx.finish} disabled={!d} data-testid="setup-check-next">
          {missing.length > 0 ? `Install ${missing.length} missing` : 'Continue'}
        </Button>
        <Button
          variant="default"
          loading={busy}
          onClick={() => {
            setBusy(true)
            void ctx.recheck().finally(() => setBusy(false))
          }}
        >
          Check again
        </Button>
        <Button variant="subtle" onClick={ctx.back}>
          Back
        </Button>
      </Group>
    </Stack>
  )
}

type Row = { status: 'wait' | 'run' | 'ok' | 'err'; percent: number; line: string }

export function InstallStep({ ctx }: { ctx: WizardCtx }) {
  const [todo, setTodo] = useState<string[] | null>(null)
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [failed, setFailed] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const alive = useRef(true)
  const entered = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const patchRow = (tool: string, r: Partial<Row>): void => {
    if (!alive.current) return
    setRows((cur) => {
      const prev: Row = cur[tool] ?? { status: 'wait', percent: 0, line: '' }
      return { ...cur, [tool]: { ...prev, ...r } }
    })
  }

  const runAll = async (tools: string[]): Promise<void> => {
    setRunning(true)
    setFailed(null)
    for (const tool of tools) {
      if (rows[tool]?.status === 'ok') continue
      patchRow(tool, { status: 'run', percent: 0, line: 'Starting…' })
      const out = await runSetup({ task: 'install', tool: tool as 'clt' }, (p) =>
        patchRow(tool, { ...(p.percent !== null ? { percent: p.percent } : {}), line: p.line }),
      )
      if (!out.ok) {
        patchRow(tool, { status: 'err', line: out.message ?? 'Failed' })
        setFailed(out.message ?? 'Failed')
        if (alive.current) setRunning(false)
        return
      }
      patchRow(tool, { status: 'ok', percent: 100, line: out.version ?? 'Installed' })
    }
    await ctx.recheck()
    if (alive.current) setRunning(false)
  }

  useEffect(() => {
    if (entered.current || !ctx.detect) return
    entered.current = true
    // Only what the latest check found missing; present tools are never reinstalled.
    const list = missingTools(ctx.detect)
    setTodo(list)
    if (list.length > 0) void runAll(list)
  }, [ctx.detect])

  const allDone = todo !== null && todo.every((t) => rows[t]?.status === 'ok')
  return (
    <Stack gap="md" data-testid="setup-install">
      {todo === null ? (
        <Text c="dimmed" size="sm">
          Checking your Mac…
        </Text>
      ) : todo.length === 0 ? (
        <Text>Everything Relay needs is already on your Mac.</Text>
      ) : (
        <Text c="dimmed" size="sm">
          Installing what is missing. If macOS asks for your password or opens an installer, follow
          it and come back here.
        </Text>
      )}
      <div className="eva-settings-card">
        {(todo ?? []).map((tool) => {
          const r = rows[tool] ?? { status: 'wait', percent: 0, line: '' }
          return (
            <div
              key={tool}
              className="eva-setup-install-row"
              data-testid={`setup-install-${tool}`}
              data-status={r.status}
            >
              <Group justify="space-between">
                <Text fw={600}>{TOOL_LABEL[tool] ?? tool}</Text>
                <Badge
                  color={r.status === 'ok' ? 'green' : r.status === 'err' ? 'red' : 'gray'}
                  variant="light"
                >
                  {r.status === 'wait'
                    ? 'Waiting'
                    : r.status === 'run'
                      ? 'Installing'
                      : r.status === 'ok'
                        ? 'Done'
                        : 'Failed'}
                </Badge>
              </Group>
              <Progress
                value={r.percent}
                size="sm"
                mt={6}
                color={r.status === 'err' ? 'red' : undefined}
              />
              <Text size="xs" c={r.status === 'err' ? 'red' : 'dimmed'} mt={4}>
                {r.line}
              </Text>
            </div>
          )
        })}
      </div>
      <Group>
        {failed ? (
          <Button
            color="red"
            variant="light"
            onClick={() => void runAll(todo ?? [])}
            data-testid="setup-install-retry"
          >
            Retry
          </Button>
        ) : null}
        <Button
          onClick={ctx.finish}
          disabled={running || todo === null || (!allDone && todo.length > 0)}
          data-testid="setup-install-next"
        >
          Continue
        </Button>
        <Button variant="subtle" onClick={ctx.back} disabled={running}>
          Back
        </Button>
      </Group>
    </Stack>
  )
}

export function AiStep({ ctx }: { ctx: WizardCtx }) {
  const login = useSetupRun()
  const key = useSetupRun()
  const [provider, setProvider] = useState<SetupProvider>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [useKey, setUseKey] = useState(false)
  const signedIn = ctx.detect?.omp.loggedIn === true
  const providers = ctx.detect?.omp.providers ?? []

  const sign = async (p: SetupProvider): Promise<void> => {
    const out = await login.start({ task: 'ai-login', provider: p })
    if (out.ok) await ctx.recheck()
  }
  const saveKey = async (): Promise<void> => {
    const out = await key.start({ task: 'ai-key', provider, key: apiKey.trim() })
    setApiKey('')
    if (out.ok) {
      setUseKey(false)
      await ctx.recheck()
    }
  }

  return (
    <Stack gap="md" data-testid="setup-ai">
      {signedIn ? (
        <>
          <Alert color="green" title="You are signed in to AI" data-testid="setup-ai-ok">
            {providers.length > 0 ? `Connected: ${providers.join(', ')}.` : 'omp is signed in.'}
          </Alert>
          <Group>
            <Button
              variant="subtle"
              onClick={() => setUseKey((v) => !v)}
              data-testid="setup-ai-key-toggle"
            >
              Use a different API key
            </Button>
          </Group>
        </>
      ) : (
        <>
          <Text c="dimmed" size="sm">
            Your assistants think with an AI account of yours. Sign in with the one you have. A
            browser window opens, and you sign in on the provider's own page.
          </Text>
          <Group>
            <Button
              onClick={() => void sign('anthropic')}
              loading={login.view.status === 'running'}
              data-testid="setup-ai-claude"
            >
              Sign in with Claude
            </Button>
            <Button
              onClick={() => void sign('openai')}
              loading={login.view.status === 'running'}
              variant="default"
              data-testid="setup-ai-chatgpt"
            >
              Sign in with ChatGPT
            </Button>
            <Button
              variant="subtle"
              onClick={() => setUseKey((v) => !v)}
              data-testid="setup-ai-key-toggle"
            >
              Use an API key
            </Button>
          </Group>
          {login.view.status === 'running' ? (
            <Text size="sm" c="dimmed">
              {login.view.line || 'Waiting for you to finish signing in in the browser…'}
            </Text>
          ) : null}
          {login.view.status === 'err' ? (
            <Alert color="red" title="Sign-in did not finish">
              {login.view.message}
            </Alert>
          ) : null}
        </>
      )}
      {useKey ? (
        <Stack gap="xs">
          <SegmentedControl
            value={provider}
            onChange={(v) => setProvider(v as SetupProvider)}
            data={[
              { value: 'anthropic', label: 'Anthropic' },
              { value: 'openai', label: 'OpenAI' },
            ]}
          />
          <PasswordInput
            label="API key"
            description="Stored by omp on this Mac. Relay does not keep a copy."
            value={apiKey}
            onChange={(e) => setApiKey(e.currentTarget.value)}
            autoComplete="off"
            data-testid="setup-ai-key"
          />
          <Group>
            <Button
              onClick={() => void saveKey()}
              disabled={apiKey.trim() === ''}
              loading={key.view.status === 'running'}
            >
              Save key
            </Button>
          </Group>
          {key.view.status === 'err' ? (
            <Alert color="red" title="Could not save the key">
              {key.view.message}
            </Alert>
          ) : null}
        </Stack>
      ) : null}
      <Group>
        <Button
          onClick={ctx.finish}
          data-testid="setup-ai-next"
          variant={signedIn ? 'filled' : 'default'}
        >
          {signedIn ? 'Continue' : 'Skip for now'}
        </Button>
        <Button variant="subtle" onClick={ctx.back}>
          Back
        </Button>
      </Group>
    </Stack>
  )
}
