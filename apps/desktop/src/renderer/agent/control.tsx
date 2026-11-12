import { Button, Group, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  CanvasBoardCallSchema,
  agentActions,
  isAgentActionId,
  type AgentActionId,
  type AgentResult,
} from '@evaos/contract'
import { canvasBoardCall } from '../canvas/agent/board-drivers'
import { invoke, on } from '../ipc'
import { readState, rendererActions } from './actions'
import { actorOf, announceChange } from './access'
import { decide, isTyping, snapshotFocus, withFocusHold } from './focus-safety'
import { isAway, startScopeWatch } from './scope'
import { startPresence } from './presence'
import { agentIdentityWithFace } from './identity'

interface Queued {
  action: AgentActionId
  params: unknown
  toast: string
}

/** Actions waiting until Isaac stops typing, oldest first. */
const queue: Queued[] = []

function errorResult(e: unknown): AgentResult {
  const code = (e as { code?: unknown } | null)?.code
  return {
    ok: false,
    code: typeof code === 'string' && /^[a-z][a-z-]*$/.test(code) ? code : 'internal',
    message: e instanceof Error ? e.message : String(e),
  }
}

async function execute(action: AgentActionId, params: unknown): Promise<AgentResult> {
  const spec = agentActions[action]
  if (spec.side !== 'renderer') {
    return { ok: false, code: 'wrong-side', message: `${action} runs in main` }
  }
  const parsed = spec.params.safeParse(params)
  if (!parsed.success) return { ok: false, code: 'invalid-params', message: parsed.error.message }
  const fn = rendererActions[action as keyof typeof rendererActions] as (p: unknown) => unknown
  try {
    return { ok: true, value: await withFocusHold(() => fn(parsed.data)) }
  } catch (e) {
    return errorResult(e)
  }
}

function runQueued(q: Queued): void {
  notifications.hide(q.toast)
  void execute(q.action, q.params).then((r) => {
    if (!r.ok) notifications.show({ color: 'red', title: 'Eva', message: r.message })
  })
}

/** Runs what waited once the text field lost focus or the window went to the background. */
function drain(): void {
  if (queue.length === 0 || isTyping(snapshotFocus())) return
  for (const q of queue.splice(0)) runQueued(q)
}

function enqueue(action: AgentActionId, params: unknown): void {
  const toast = `agent-queued-${Date.now()}-${queue.length}`
  const q: Queued = { action, params, toast }
  queue.push(q)
  notifications.show({
    id: toast,
    autoClose: false,
    withCloseButton: false,
    title: 'Eva is waiting for you to finish typing',
    message: (
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="sm">{agentActions[action].title}</Text>
        <Button
          size="compact-xs"
          variant="light"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const at = queue.indexOf(q)
            if (at >= 0) queue.splice(at, 1)
            runQueued(q)
          }}
        >
          Run now
        </Button>
      </Group>
    ),
  })
}

/** Runs one request from main; exported as a test seam. */
export async function dispatch(action: string, params: unknown): Promise<AgentResult> {
  if (action === '@state') {
    try {
      return { ok: true, value: await readState() }
    } catch (e) {
      return errorResult(e)
    }
  }
  // Main's connections.* say what they changed, as the agent that asked.
  if (action === '@announce') {
    const p = params as { scope?: string; text?: string }
    announceChange(`${actorOf(p.scope)} ${p.text ?? 'changed something'}`)
    return { ok: true, value: {} }
  }
  // Main's browser drive asks who a session is: its face and color on the pages it drives.
  if (action === '@agentOf') {
    const scope =
      typeof params === 'object' &&
      params !== null &&
      'scope' in params &&
      typeof params.scope === 'string'
        ? params.scope
        : undefined
    try {
      return { ok: true, value: await agentIdentityWithFace(scope) }
    } catch (e) {
      return errorResult(e)
    }
  }
  // Main's canvas drive works the board on screen: the cursor, saving, boxes, selection, view, drags.
  if (action === '@canvas') {
    const call = CanvasBoardCallSchema.safeParse(params)
    if (!call.success) return { ok: false, code: 'invalid-params', message: call.error.message }
    try {
      return { ok: true, value: await canvasBoardCall(call.data) }
    } catch (e) {
      return errorResult(e)
    }
  }
  if (!isAgentActionId(action)) {
    return { ok: false, code: 'unknown-action', message: `No action ${action}` }
  }
  // A panel action for a page not in front changes nothing on screen, so it never waits.
  const spec = agentActions[action]
  const scope =
    typeof params === 'object' && params !== null && 'scope' in params ? params.scope : undefined
  const away = spec.focus === 'panel' && (await isAway(scope))
  if (!away && decide(spec.focus, snapshotFocus()) === 'queue') {
    enqueue(action, params)
    return { ok: true, value: { reason: 'Isaac is typing' }, queued: true }
  }
  return execute(action, params)
}

/** Isaac approves or denies a destructive action; closing or ignoring the toast denies it. */
function askIsaac(id: string, title: string, detail: string, timeoutMs: number): void {
  const toast = `agent-confirm-${id}`
  let answered = false
  const answer = (approved: boolean): void => {
    if (answered) return
    answered = true
    notifications.hide(toast)
    void invoke('agent.confirm.reply', { id, approved })
  }
  notifications.show({
    id: toast,
    autoClose: false,
    color: 'yellow',
    title: `Eva asks: ${title}`,
    onClose: () => answer(false),
    message: (
      <>
        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
          {detail}
        </Text>
        <Group gap="xs" mt="xs">
          <Button
            size="compact-xs"
            color="red"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => answer(true)}
          >
            Allow
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => answer(false)}
          >
            Deny
          </Button>
        </Group>
      </>
    ),
  })
  setTimeout(() => answer(false), timeoutMs)
}

/** Answers main's agent-control requests (main/agent-control). */
export function startAgentControl(): () => void {
  const offRun = on('agent.run', ({ id, action, params }) => {
    void dispatch(action, params).then((result) => invoke('agent.reply', { id, result }))
  })
  const offConfirm = on('agent.confirm', ({ id, title, detail, timeoutMs }) =>
    askIsaac(id, title, detail, timeoutMs),
  )
  const offScopes = startScopeWatch()
  const offPresence = startPresence()
  // focusout fires before the next element takes focus; check once it has.
  const later = (): void => void setTimeout(drain, 0)
  document.addEventListener('focusout', later, true)
  window.addEventListener('blur', later)
  return () => {
    offRun()
    offConfirm()
    offScopes()
    offPresence()
    document.removeEventListener('focusout', later, true)
    window.removeEventListener('blur', later)
  }
}
