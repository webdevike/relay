import { assistantAvatarSvg } from '@relay/portrait-motion'
import type { AgentIdentity } from '@evaos/contract'
import { agentOf, assistantsStore } from '../assistants/assistants-store'
import { agentTitle } from '../eva/names-store'
import { portrait } from '../ui/portrait'
import { targetOf } from './scope'

/** Eva's own color on the pages she drives (a session that is no assistant's). */
export const EVA_AGENT_COLOR = '#8da2fb'

/** The workspace (browser scope) a session's scope resolves to, null when none or unresolvable. */
async function workspaceOf(scope: string | undefined): Promise<string | null> {
  if (scope === undefined) return null
  try {
    return (await targetOf(scope)).scope
  } catch {
    return null
  }
}

/** Who works for workspace `ws`: its assistant (`page:agent:penny`: name, accent), else Eva. */
function identityOf(ws: string | null): AgentIdentity {
  const id = ws?.startsWith('page:agent:') ? ws.slice('page:agent:'.length) : null
  if (!id) return { id: null, name: 'Eva', color: EVA_AGENT_COLOR }
  const a = agentOf(assistantsStore.getState(), id)
  return {
    id,
    name: agentTitle(id) ?? `${id[0]!.toUpperCase()}${id.slice(1)}`,
    color: a?.avatar.colors?.accent ?? EVA_AGENT_COLOR,
  }
}

/** Who drives pages for the calling session: its assistant (name, accent), else Eva. */
export async function agentIdentity(scope: string | undefined): Promise<AgentIdentity> {
  return identityOf(await workspaceOf(scope))
}

/**
 * The identity plus its portrait as SVG text (for the cursor main draws on a page or board) and
 * the calling session's workspace (where its canvas runs show their work cards).
 */
export async function agentIdentityWithFace(
  scope: string | undefined,
): Promise<AgentIdentity & { avatar: string; workspace: string | null }> {
  const workspace = await workspaceOf(scope)
  const who = identityOf(workspace)
  const a = who.id === null ? null : agentOf(assistantsStore.getState(), who.id)
  return { ...who, avatar: assistantAvatarSvg(a?.avatar ?? who.id ?? 'eva'), workspace }
}

/** An agent's face on its tab and work card, as an image URL. */
export function agentFace(id: string | null): string {
  const a = id === null ? null : agentOf(assistantsStore.getState(), id)
  return portrait(a?.avatar ?? id ?? 'eva')
}
