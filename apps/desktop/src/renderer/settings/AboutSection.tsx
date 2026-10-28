import { Anchor } from '@mantine/core'
import type { MouseEvent } from 'react'
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

/** Third-party art the app ships, with the credit its license asks for. */
export function AboutSection() {
  return (
    <div className="eva-settings-card">
      <div className="eva-settings-row eva-settings-row-static" data-testid="settings-credits">
        <span className="eva-settings-label">
          <span className="eva-settings-label-title">Credits</span>
          <span className="eva-settings-label-help">
            Nova avatar: Micah by Micah Lanier, CC BY 4.0, modified (
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
