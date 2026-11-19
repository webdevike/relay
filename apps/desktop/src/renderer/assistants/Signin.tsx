import { Button, Code, CopyButton, Group, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import type { SigninFix } from '@evaos/contract'
import { agentOf, useAssistants } from './assistants-store'
import { fixOf, signInAgain, signinKey, signinPlan, troubleOf, useSignin } from './agent-signin'
import './signin.css'

/**
 * "Sign in again" for `fix`: omp's browser sign-in under its profile on this Mac; for a provider
 * setup cannot sign in, the command to copy; on a thin client, where to do it on the host's Mac.
 */
export function SigninAction({
  fix,
  hostMac,
  primary = true,
  testId,
}: {
  fix: SigninFix
  hostMac: string | undefined
  /** The loud button (a broken sign-in); else a quiet one (signing in again a working one). */
  primary?: boolean
  testId: string
}) {
  const busy = useSignin((s) => s.busy[signinKey(fix)] === true)
  const plan = signinPlan(fix, hostMac)
  if (plan.kind === 'elsewhere') {
    return (
      <Text size="sm" className="eva-signin-elsewhere" data-testid={`${testId}-elsewhere`}>
        Sign in on {plan.mac}: Relay &gt; Settings &gt; Connections
      </Text>
    )
  }
  if (plan.kind === 'command') {
    return (
      <Group gap="xs" wrap="nowrap" data-testid={`${testId}-command`}>
        <Code>{plan.command}</Code>
        <CopyButton value={plan.command}>
          {({ copied, copy }) => (
            <Button size="xs" variant="default" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </Group>
    )
  }
  return (
    <Button
      size="xs"
      variant={primary ? 'filled' : 'default'}
      loading={busy}
      data-testid={testId}
      onClick={() => void signInAgain(fix, plan.provider)}
    >
      Sign in again
    </Button>
  )
}

/** What the last "Sign in again" for `fix` said, while there is something to say. */
export function SigninNote({ fix, testId }: { fix: SigninFix; testId: string }) {
  const note = useSignin((s) => s.notes[signinKey(fix)])
  return note ? (
    <Text size="sm" data-testid={testId}>
      {note}
    </Text>
  ) : null
}

/**
 * The end of an assistant's thread, over the composer, while its last turn failed with no reply
 * since (the host's `failure`, which it clears when a reply lands) or its profile's sign-in is
 * broken: what happened in the host's words, and "Sign in again" when signing in fixes it. A turn
 * that failed before it started is in no session file, so without this the thread would just stay
 * silent.
 */
export function FailureStrip({ agent: id }: { agent: string }) {
  const agent = useAssistants((s) => agentOf(s, id))
  const hostMac = useAssistants((s) => s.data?.hostMac)
  const trouble = agent ? troubleOf(agent) : null
  if (!agent || !trouble) return null
  const fix = fixOf(agent)
  return (
    <div
      className="eva-signin-strip"
      role="alert"
      data-tone={trouble.tone}
      data-testid={`turn-failure-${id}`}
    >
      <div className="eva-signin-strip-body">
        <Text size="sm" fw={600} className="eva-signin-strip-title">
          <IconAlertTriangle size={16} stroke={1.75} aria-hidden />
          {trouble.title}
        </Text>
        <Text size="sm">{trouble.text}</Text>
        {fix ? <SigninNote fix={fix} testId={`turn-failure-${id}-note`} /> : null}
      </div>
      {fix ? (
        <div className="eva-signin-strip-action">
          <SigninAction fix={fix} hostMac={hostMac} testId={`turn-failure-${id}-signin`} />
        </div>
      ) : null}
    </div>
  )
}
