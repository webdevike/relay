import './sign-in-card.css'
import { StatusCard } from './status-card/StatusCard'
import { useState, type FormEvent } from 'react'
import { Button, PasswordInput, TextInput } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconCheck, IconKey, IconWorld } from '@tabler/icons-react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { EVA_COMPUTER_URL, type SigninHandoff } from '@relay/protocol'
import { MAX_SIGNIN_FIELD } from '@evaos/contract'
import { invoke } from '../ipc'
import { browserStore } from '../browser/browser-store'
import { activateTab, paneSnapshot } from '../tiling/tiling-store'
import { openWebPage, showWebTab, webPanelId } from '../tiling/web-tabs'

/**
 * Sign-ins this app sent and the host took, as `agent:messageId`, shown submitted from then on.
 * Memory only, like the host's own mark (the phone's `signedIn`).
 */
const signedInStore = createStore<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set() }))

const EVA_COMPUTER_ORIGIN = new URL(EVA_COMPUTER_URL).origin

/**
 * Eva's contained browser (its live web screen, already on the login page the agent opened) as a
 * page tab of this workspace: the one showing it already, else a new one in the pane holding pages
 * or a new pane right of the chat. He signs in there and the session lands in Eva's profile.
 */
async function openEvaComputer(): Promise<void> {
  const page = browserStore.getState().tabs.find((t) => t.url.startsWith(EVA_COMPUTER_ORIGIN))
  if (page !== undefined) {
    const panel = webPanelId(page.id)
    if (paneSnapshot().panes.some((p) => p.views.includes(panel))) activateTab(panel)
    else showWebTab(page.id)
    return
  }
  await openWebPage({ url: EVA_COMPUTER_URL })
}

/**
 * The card a reply's `[[signin:<url>]]` turns into, as on the phone: the site's icon and `Sign in
 * to <host>`, `Open Eva's browser` (her live screen in the side panel), and, in an assistant
 * thread (`agent`), `Use password`: a form whose `signin.submit` the host types into the page, so
 * the model never sees it. A check and `Credentials submitted` once the host took them.
 */
export function SignInCard({
  signin,
  agent,
  messageId,
}: {
  signin: SigninHandoff
  agent: string | undefined
  messageId: string
}) {
  const key = `${agent ?? ''}:${messageId}`
  const submitted = useStore(signedInStore, (s) => s.keys.has(key))
  const [form, setForm] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [iconFailed, setIconFailed] = useState(false)
  const ready = username.trim() !== '' && password !== '' && !busy
  const [expanded, setExpanded] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (agent === undefined || !ready) return
    setBusy(true)
    setFailure(null)
    const r = await invoke('signin.submit', {
      agent,
      messageId,
      url: signin.url,
      username: username.trim(),
      password,
    })
    setBusy(false)
    if (!r.ok) {
      setFailure(r.error.message || "Couldn't sign in.")
      return
    }
    setPassword('')
    setForm(false)
    setExpanded(false)
    signedInStore.setState((s) => ({ keys: new Set([...s.keys, key]) }))
  }

  const icon = iconFailed ? (
    <span className="eva-signin-card-icon">
      <IconWorld size={16} stroke={1.5} />
    </span>
  ) : (
    <img
      className="eva-signin-card-icon"
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(signin.host)}&sz=64`}
      alt=""
      onError={() => setIconFailed(true)}
    />
  )

  return (
    <StatusCard
      id={`signin:${key}`}
      testId="signin-card"
      data={{ 'data-submitted': submitted || undefined }}
      lead={icon}
      line={`Sign in to ${signin.host}`}
      lineTitle={signin.url}
      open={expanded}
      onOpenChange={setExpanded}
      actions={
        <>
          <Button
            size="compact-xs"
            leftSection={<IconWorld size={14} stroke={1.5} />}
            data-testid="signin-open-browser"
            onClick={() => {
              openEvaComputer().catch(() => {
                notifications.show({
                  message: "Relay could not open Eva's browser.",
                  color: 'yellow',
                })
              })
            }}
          >
            Open Eva&apos;s browser
          </Button>
          {agent !== undefined && !submitted ? (
            <Button
              size="compact-xs"
              variant={form ? 'light' : 'default'}
              leftSection={<IconKey size={14} stroke={1.5} />}
              data-testid="signin-use-password"
              aria-expanded={form && expanded}
              onClick={() => {
                const close = form && expanded
                setForm(!close)
                setExpanded(!close)
              }}
            >
              Use password
            </Button>
          ) : null}
        </>
      }
      meta={
        submitted ? (
          <>
            <IconCheck size={14} stroke={2} aria-hidden />
            Credentials submitted
          </>
        ) : undefined
      }
      details={
        <>
          <div className="eva-signin-card-sub">{signin.url}</div>
          {form && !submitted ? (
            <form className="eva-signin-card-form" onSubmit={(e) => void submit(e)}>
              <div className="eva-signin-card-sub">
                Goes straight into the page in Eva&apos;s browser. She never sees it.
              </div>
              <TextInput
                size="sm"
                placeholder="Username or email"
                aria-label="Username or email"
                autoComplete="username"
                autoFocus
                maxLength={MAX_SIGNIN_FIELD}
                disabled={busy}
                value={username}
                onChange={(e) => setUsername(e.currentTarget.value)}
              />
              <PasswordInput
                size="sm"
                placeholder="Password"
                aria-label="Password"
                autoComplete="current-password"
                maxLength={MAX_SIGNIN_FIELD}
                disabled={busy}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
              />
              {failure !== null ? (
                <div className="eva-signin-card-error" role="alert">
                  {failure}
                </div>
              ) : null}
              <div className="eva-signin-card-actions">
                <Button type="submit" size="sm" loading={busy} disabled={!ready}>
                  Sign in
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  color="gray"
                  disabled={busy}
                  onClick={() => {
                    setForm(false)
                    setFailure(null)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
        </>
      }
    />
  )
}
