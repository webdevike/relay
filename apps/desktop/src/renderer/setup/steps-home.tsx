import { ActionIcon, Alert, Avatar, Button, Group, Progress, SegmentedControl, Stack, Text, TextInput } from '@mantine/core'
import { IconPlus, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { SetupAssistant } from '@evaos/contract'
import { invoke } from '../ipc'
import { portrait } from '../ui/portrait'
import { assistantId, useSetupRun } from './run'
import type { WizardCtx } from './wizard'

const LAYERS: ReadonlyArray<readonly [string, string, string]> = [
  ['L0', 'AGENTS.md', 'Who you are and where things live. Every assistant reads it first.'],
  ['L1', 'Ready file', 'A short status note: what is going on right now.'],
  ['L2', 'Workspaces', 'One card per project you work on.'],
  ['L3', 'Workflows and references', 'How you like things done, written down once.'],
  ['L4', 'Memory and work', 'What your assistants remember and are working on.'],
]

function Layers() {
  return (
    <div className="eva-setup-layers" data-testid="setup-layers" role="list">
      {LAYERS.map(([tag, name, text], i) => (
        <div
          key={tag}
          role="listitem"
          className="eva-setup-layer"
          // Wider bars further down: each layer builds on the one above.
          style={{ width: `${58 + i * 10.5}%` }}
        >
          <span className="eva-setup-layer-tag">{tag}</span>
          <span>
            <strong>{name}</strong>
            <span className="eva-setup-layer-text"> {text}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function HomeStep({ ctx }: { ctx: WizardCtx }) {
  const s = ctx.state
  const [root, setRoot] = useState(s.root ?? ctx.defaultRoot)
  const [userName, setUserName] = useState(s.userName ?? '')
  const [ws, setWs] = useState(s.firstWorkspace?.name ?? '')
  const [wsText, setWsText] = useState(s.firstWorkspace?.description ?? '')
  const rootOk = root.trim() !== '' && (root.startsWith('/') || root.startsWith('~/'))
  return (
    <Stack gap="md" data-testid="setup-home">
      <Text>
        Your home base is one folder on your Mac. Your assistants read it to know you and write to it
        to remember. It has five layers, from the most general to the most current:
      </Text>
      <Layers />
      <TextInput
        label="Where should it live?"
        description="Created if it does not exist. Existing files are never overwritten."
        value={root}
        onChange={(e) => setRoot(e.currentTarget.value)}
        error={rootOk ? undefined : 'Use a full path like ~/Relay'}
        data-testid="setup-root"
      />
      <TextInput
        label="Your name"
        value={userName}
        onChange={(e) => setUserName(e.currentTarget.value)}
        data-testid="setup-username"
      />
      <Group grow align="flex-start">
        <TextInput
          label="First workspace (optional)"
          placeholder="A project you work on"
          value={ws}
          onChange={(e) => setWs(e.currentTarget.value)}
        />
        <TextInput
          label="In one line"
          value={wsText}
          onChange={(e) => setWsText(e.currentTarget.value)}
        />
      </Group>
      <Group>
        <Button
          disabled={!rootOk || userName.trim() === ''}
          data-testid="setup-home-next"
          onClick={() => {
            ctx.patch({
              root: root.trim(),
              userName: userName.trim(),
              ...(ws.trim() !== '' ? { firstWorkspace: { name: ws.trim(), description: wsText.trim() } } : {}),
            })
            ctx.finish()
          }}
        >
          Continue
        </Button>
        <Button variant="subtle" onClick={ctx.back}>
          Back
        </Button>
      </Group>
    </Stack>
  )
}

const PRESETS: Record<string, SetupAssistant[]> = {
  one: [{ id: 'relay', name: 'Relay', purpose: 'A general assistant for anything I ask.' }],
  pair: [
    { id: 'home', name: 'Home', purpose: 'My personal life: plans, errands, reading, ideas.' },
    { id: 'work', name: 'Work', purpose: 'My job: projects, writing, code, meetings.' },
  ],
}

export function AssistantsStep({ ctx }: { ctx: WizardCtx }) {
  const [preset, setPreset] = useState('one')
  const [list, setList] = useState<SetupAssistant[]>(ctx.state.assistants ?? PRESETS.one!)
  const run = useSetupRun()
  const edit = (i: number, change: Partial<SetupAssistant>): void =>
    setList((cur) => cur.map((a, j) => (j === i ? { ...a, ...change } : a)))
  const valid = list.length > 0 && list.every((a) => a.name.trim() !== '')

  const create = async (): Promise<void> => {
    const taken: string[] = []
    const assistants = list.map((a) => {
      const id = assistantId(a.id || a.name, taken)
      taken.push(id)
      return {
        id,
        name: a.name.trim(),
        purpose: a.purpose.trim(),
        ...(a.model?.trim() ? { model: a.model.trim() } : {}),
      }
    })
    const root = ctx.state.root ?? ctx.defaultRoot
    const out = await run.start({
      task: 'scaffold',
      root,
      answers: {
        userName: ctx.state.userName ?? 'Me',
        assistants,
        ...(ctx.state.firstWorkspace ? { firstWorkspace: ctx.state.firstWorkspace } : {}),
      },
    })
    if (out.ok) {
      ctx.patch({ assistants })
      ctx.finish()
    }
  }

  return (
    <Stack gap="md" data-testid="setup-assistants">
      <Text c="dimmed" size="sm">
        An assistant is a long-running chat with its own job and memory. Start small; you can add more
        any time.
      </Text>
      <SegmentedControl
        value={preset}
        onChange={(v) => {
          setPreset(v)
          setList(PRESETS[v]!.map((a) => ({ ...a })))
        }}
        data={[
          { value: 'one', label: 'One general assistant' },
          { value: 'pair', label: 'Personal + work' },
        ]}
        data-testid="setup-preset"
      />
      {list.map((a, i) => {
        const id = assistantId(a.id || a.name, list.slice(0, i).map((x) => assistantId(x.id || x.name, [])))
        return (
          <div key={i} className="eva-setup-assistant" data-testid={`setup-assistant-${i}`}>
            <Avatar src={portrait({ style: 'micah', seed: id })} size={56} radius="xl" alt="" />
            <Stack gap={6} style={{ flex: 1 }}>
              <TextInput
                label="Name"
                value={a.name}
                onChange={(e) => edit(i, { name: e.currentTarget.value, id: '' })}
              />
              <TextInput
                label="What is it for?"
                value={a.purpose}
                onChange={(e) => edit(i, { purpose: e.currentTarget.value })}
              />
              <TextInput
                label="Model (optional)"
                placeholder="Leave empty to use your default"
                value={a.model ?? ''}
                onChange={(e) => edit(i, { model: e.currentTarget.value })}
              />
            </Stack>
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label="Remove assistant"
              disabled={list.length <= 1}
              onClick={() => setList((cur) => cur.filter((_, j) => j !== i))}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </div>
        )
      })}
      <Group>
        <Button
          variant="default"
          leftSection={<IconPlus size={14} />}
          disabled={list.length >= 6}
          onClick={() => setList((cur) => [...cur, { id: '', name: '', purpose: '' }])}
        >
          Add an assistant
        </Button>
      </Group>
      {run.view.status === 'running' ? (
        <>
          <Progress value={run.view.percent} size="sm" />
          <Text size="xs" c="dimmed">
            {run.view.line}
          </Text>
        </>
      ) : null}
      {run.view.status === 'err' ? (
        <Alert color="red" title="Could not create your home base" data-testid="setup-scaffold-error">
          {run.view.message}
        </Alert>
      ) : null}
      <Group>
        <Button
          disabled={!valid}
          loading={run.view.status === 'running'}
          onClick={() => void create()}
          data-testid="setup-assistants-next"
        >
          {run.view.status === 'err' ? 'Try again' : 'Create my home base'}
        </Button>
        <Button variant="subtle" onClick={ctx.back} disabled={run.view.status === 'running'}>
          Back
        </Button>
      </Group>
    </Stack>
  )
}

export function HostStep({ ctx }: { ctx: WizardCtx }) {
  const [name, setName] = useState(ctx.state.hostName ?? ctx.computerName)
  const [waiting, setWaiting] = useState(false)
  const [up, setUp] = useState<number | null>(null)
  const [timedOut, setTimedOut] = useState(false)
  const run = useSetupRun()
  const root = ctx.state.root ?? ctx.defaultRoot

  const install = async (): Promise<void> => {
    setTimedOut(false)
    const out = await run.start({ task: 'install-host', root, hostName: name.trim() })
    if (!out.ok) return
    ctx.patch({ hostName: name.trim() })
    setWaiting(true)
  }

  // After the install, wait for the host to answer on its port.
  useEffect(() => {
    if (!waiting) return
    let cancelled = false
    void (async () => {
      for (let i = 0; i < 30 && !cancelled; i++) {
        const r = await invoke('setup.health', { root })
        if (r.ok && r.value.hostPort !== null) {
          if (!cancelled) {
            setUp(r.value.hostPort)
            setWaiting(false)
          }
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
      }
      if (!cancelled) {
        setTimedOut(true)
        setWaiting(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [waiting, root])

  return (
    <Stack gap="md" data-testid="setup-host">
      <Text c="dimmed" size="sm">
        Relay Host runs quietly on this Mac. It keeps your assistants going and is what your iPhone
        talks to. It starts by itself when you log in.
      </Text>
      <TextInput
        label="Name of this computer in Relay"
        description="Shown on your iPhone."
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        disabled={run.view.status === 'running' || up !== null}
        data-testid="setup-hostname"
      />
      {run.view.status === 'running' || waiting ? (
        <>
          <Progress value={waiting ? 100 : run.view.percent} animated={waiting} size="sm" />
          <Text size="xs" c="dimmed">
            {waiting ? 'Waiting for Relay Host to start…' : run.view.line}
          </Text>
        </>
      ) : null}
      {up !== null ? (
        <Alert color="green" title="Relay Host is running" data-testid="setup-host-ok">
          Listening on port {up}.
        </Alert>
      ) : null}
      {run.view.status === 'err' ? (
        <Alert color="red" title="Could not install Relay Host" data-testid="setup-host-error">
          {run.view.message}
        </Alert>
      ) : null}
      {timedOut ? (
        <Alert color="yellow" title="Relay Host has not answered yet">
          It may still be starting. Try again, or continue and check from the last step.
        </Alert>
      ) : null}
      <Group>
        {up === null ? (
          <Button
            onClick={() => void install()}
            disabled={name.trim() === ''}
            loading={run.view.status === 'running' || waiting}
            data-testid="setup-host-install"
          >
            {run.view.status === 'err' || timedOut ? 'Try again' : 'Install Relay Host'}
          </Button>
        ) : null}
        <Button
          onClick={() => {
            ctx.patch({ hostName: name.trim() })
            ctx.finish()
          }}
          variant={up !== null ? 'filled' : 'default'}
          disabled={run.view.status === 'running' || waiting}
          data-testid="setup-host-next"
        >
          {up !== null ? 'Continue' : 'Skip for now'}
        </Button>
        <Button variant="subtle" onClick={ctx.back} disabled={run.view.status === 'running'}>
          Back
        </Button>
      </Group>
    </Stack>
  )
}
