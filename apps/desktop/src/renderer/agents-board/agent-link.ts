import type { AgentOpen } from '@evaos/contract'
import { openActivity } from '../activity/open-activity'
import { openContext } from '../context/open-context'
import type { OpenTarget } from '../navigation/open-target'

/** Opens a board link: a live run through the activity opener, everything else as a context row does. */
export function openAgentLink(open: AgentOpen, target: OpenTarget): void {
  if (open.kind === 'activity') void openActivity(open.item, target)
  else openContext(open, target)
}
