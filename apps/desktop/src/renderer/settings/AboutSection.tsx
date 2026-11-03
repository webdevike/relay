import { Anchor } from '@mantine/core'
import type { MouseEvent } from 'react'
import { micahCredit } from '@relay/portrait-motion'
import { useAssistants } from '../assistants/assistants-store'
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

/**
 * Third-party art the app shows, with the credit its license asks for: every assistant the
 * registry draws with Micah; nothing while none is.
 */
export function AboutSection() {
  const micah = useAssistants((s) =>
    micahCredit((s.data?.agents ?? []).map((a) => ({ title: a.title, style: a.avatar.style }))),
  )
  if (micah === null) return null
  return (
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
  )
}
