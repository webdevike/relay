import { assistantAvatarSvg } from '@relay/portrait-motion'
import type { AgentIdentity } from '@evaos/contract'
import { agentOf, assistantsStore } from '../assistants/assistants-store'
import { agentTitle } from '../eva/names-store'
import { portrait } from '../ui/portrait'
import { targetOf } from './scope'

/** Eva's own color on the pages she drives (a session that is no assistant's). */
export const EVA_AGENT_COLOR = '#8da2fb'

/** The assistant a scope's session works for (`page:agent:penny` -> penny), else null. */
async function assistantOf(scope: string | undefined): Promise<string | null> {
  if (scope === undefined) return null
  try {
    const t = await targetOf(scope)
    return t.scope.startsWith('page:agent:') ? t.scope.slice('page:agent:'.length) : null
  } catch {
    return null
  }
}

/** Who drives pages for the calling session: its assistant (name, accent), else Eva. */
export async function agentIdentity(scope: string | undefined): Promise<AgentIdentity> {
  const id = await assistantOf(scope)
  if (id === null) return { id: null, name: 'Eva', color: EVA_AGENT_COLOR }
  const a = agentOf(assistantsStore.getState(), id)
  return {
    id,
    name: agentTitle(id) ?? `${id[0]!.toUpperCase()}${id.slice(1)}`,
    color: a?.avatar.colors?.accent ?? EVA_AGENT_COLOR,
  }
}

/** The identity plus its portrait as SVG text, for the cursor main draws in the page. */
export async function agentIdentityWithFace(
  scope: string | undefined,
): Promise<AgentIdentity & { avatar: string }> {
  const who = await agentIdentity(scope)
  const a = who.id === null ? null : agentOf(assistantsStore.getState(), who.id)
  return { ...who, avatar: assistantAvatarSvg(a?.avatar ?? who.id ?? 'eva') }
}

/** An agent's face on its tab and work card, as an image URL. */
export function agentFace(id: string | null): string {
  const a = id === null ? null : agentOf(assistantsStore.getState(), id)
  return portrait(a?.avatar ?? id ?? 'eva')
}
