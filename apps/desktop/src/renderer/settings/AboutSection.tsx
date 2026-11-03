import { Anchor, Button } from '@mantine/core'
import { useState, type MouseEvent } from 'react'
import { shortBuild, type UpdateCheckStatus } from '@evaos/contract'
import { micahCredit } from '@relay/portrait-motion'
import { formatStamp, hostLabel, useAbout } from '../about/build-info'
import { useAssistants } from '../assistants/assistants-store'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'

/** A credit's link: opens in the browser panel like a chat link. */
function CreditLink({ href, children }: { href: string; children: string }) {
  return (
    <Anchor
      href={href}
      title={href}
      inherit
      onClick={(e: MouseEvent) => {
        e.preventDefault()
        openLink(href)
      }}
    >
      {children}
    </Anchor>
  )
}

const CHECK_RESULT: Record<UpdateCheckStatus, string> = {
  unavailable: 'This copy has no update source.',
  current: "You're up to date.",
  ready: 'An update is ready.',
  failed: "Couldn't check. Try again.",
  busy: 'Already checking.',
}

/** Which build this is, the host it talks to, and a way to look for a newer one now. */
function BuildCard() {
  const about = useAbout(5000)
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const check = (): void => {
    setChecking(true)
    setResult(null)
    void invoke('update.check', {}).then((r) => {
      setChecking(false)
      setResult(r.ok ? CHECK_RESULT[r.value.status] : "Couldn't check. Try again.")
    })
  }
  return (
    <div className="eva-settings-card" data-testid="settings-build">
      <div className="eva-settings-row eva-settings-row-static">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Relay</span>
          <span className="eva-settings-label-help" data-testid="about-build">
            {`${shortBuild(about?.build ?? null) ?? 'dev'} · built ${formatStamp(__RELAY_BUILT_AT__)}`}
          </span>
        </span>
      </div>
      <div className="eva-settings-row eva-settings-row-static">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Update channel</span>
          <span className="eva-settings-label-help" data-testid="about-channel">
            {about?.instance ?? ''}
          </span>
        </span>
      </div>
      <div className="eva-settings-row eva-settings-row-static">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Relay Host</span>
          <span className="eva-settings-label-help" data-testid="about-host">
            {about === null ? '' : hostLabel(about)}
          </span>
        </span>
      </div>
      <div className="eva-settings-row eva-settings-row-static">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Check for updates</span>
          <span className="eva-settings-label-help" data-testid="about-check-result">
            {result ?? 'Looks for a newer build now instead of waiting for the next poll.'}
          </span>
        </span>
        <Button
          size="sm"
          variant="default"
          loading={checking}
          onClick={check}
          data-testid="about-check"
        >
          Check now
        </Button>
      </div>
    </div>
  )
}

/**
 * The running build and host, then the credit for third-party art the app shows: every assistant
 * the registry draws with Micah; no credit card while none is.
 */
export function AboutSection() {
  const micah = useAssistants((s) =>
    micahCredit((s.data?.agents ?? []).map((a) => ({ title: a.title, style: a.avatar.style }))),
  )
  return (
    <>
      <BuildCard />
      {micah === null ? null : (
        <div className="eva-settings-card">
          <div className="eva-settings-row eva-settings-row-static" data-testid="settings-credits">
            <span className="eva-settings-label">
              <span className="eva-settings-label-title">Credits</span>
              <span className="eva-settings-label-help">
                {micah} (
                <CreditLink href="https://www.dicebear.com/styles/micah/">
                  dicebear.com/styles/micah
                </CreditLink>
                ,{' '}
                <CreditLink href="https://creativecommons.org/licenses/by/4.0/">
                  creativecommons.org/licenses/by/4.0
                </CreditLink>
                )
              </span>
            </span>
          </div>
        </div>
      )}
    </>
  )
}
