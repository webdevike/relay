import type { MouseEvent, ReactNode } from 'react'
import { IconArrowUpRight } from '@tabler/icons-react'
import { appLinkLabel } from '@evaos/contract'
import { parseAppLink } from '@evaos/chat-core/widget'
import { agentTitle } from '../../eva/names-store'
import { openTargetOf } from '../../navigation/open-target'
import { openLink } from '../../navigation/open-link'

/**
 * A relay:// link in a reply (`[Settings › Connections](relay://open/settings/connections)`, or a
 * bare URL): a small button that opens that place in Relay, beside the chat by default (Option:
 * here, Cmd+Shift: a new tab). A bare URL reads as where it goes.
 */
export function AppLink({ href, children }: { href: string; children: ReactNode }) {
  const link = parseAppLink(href)
  const bare =
    typeof children === 'string'
      ? children === href
      : Array.isArray(children) && children.length === 1 && children[0] === href
  const label =
    bare && link !== null
      ? link.kind === 'assistant'
        ? (agentTitle(link.id) ?? appLinkLabel(link))
        : appLinkLabel(link)
      : children
  return (
    <a
      href={href}
      title={href}
      className="eva-md-applink"
      data-testid="app-link"
      onClick={(e: MouseEvent) => {
        e.preventDefault()
        openLink(href, { target: openTargetOf(e) })
      }}
    >
      <span>{label}</span>
      <IconArrowUpRight size={14} stroke={1.75} aria-hidden />
    </a>
  )
}
