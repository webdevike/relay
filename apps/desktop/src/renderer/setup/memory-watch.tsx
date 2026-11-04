import { Button, Group } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { placeOf } from '@evaos/shell-core'
import type { HindsightProblem } from '@evaos/contract'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'

const TOAST_ID = 'relay-memory'
const EVERY_MS = 10 * 60_000
const FIRST_MS = 20_000

/** The problem the toast shows now (null: none), so a repeat poll does not re-pop it. */
let shown: string | null = null
/** Nothing is set up, so there is nothing to watch (and no reason to ask Docker every 10 minutes). */
let idle = false

function show(problem: HindsightProblem): void {
  if (shown === problem.message) return
  shown = problem.message
  notifications.hide(TOAST_ID)
  notifications.show({
    id: TOAST_ID,
    autoClose: false,
    withCloseButton: true,
    color: 'red',
    title: problem.message,
    'data-testid': 'memory-toast',
    message: (
      <Group gap="xs" mt="xs">
        <Button
          size="compact-xs"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            notifications.hide(TOAST_ID)
            openPlace(placeOf('settings', { settingsSection: 'Setup' }))
          }}
        >
          {problem.fix === 'sign-in' ? 'Sign in again' : 'Fix it'}
        </Button>
      </Group>
    ),
  })
}

/** Asks main how memory is doing and shows one toast per problem; a clean check clears it. */
export async function checkMemory(): Promise<void> {
  const r = await invoke('setup.hindsight.status', {})
  if (!r.ok) return
  idle = r.value.engine === 'none'
  if (r.value.problem) {
    show(r.value.problem)
    return
  }
  shown = null
  notifications.hide(TOAST_ID)
}

/** Starter profile only: a first check shortly after launch, then every 10 minutes. */
export function startMemoryWatch(): () => void {
  const first = setTimeout(() => void checkMemory(), FIRST_MS)
  const every = setInterval(() => {
    if (!idle) void checkMemory()
  }, EVERY_MS)
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
