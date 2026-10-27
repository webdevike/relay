import {
  agentActions,
  isAgentActionId,
  type AgentActionId,
  type AgentActionSpec,
  type AgentResult,
} from '@evaos/contract'
import type { RunBody } from './server'

export interface RunDeps {
  /** Runs a validated action on its side. */
  run(id: AgentActionId, spec: AgentActionSpec, params: unknown): Promise<AgentResult>
  /** Shows Isaac the in-app approval toast; false when he denies or lets it time out. */
  ask(id: AgentActionId, spec: AgentActionSpec, params: unknown): Promise<boolean>
}

/**
 * One request through the registry: known id, params valid for its schema, and for destructive
 * actions both the agent's `confirm: true` and Isaac's approval. Default is deny: without
 * `confirm` the toast never shows, and an unanswered toast is a no.
 */
export async function runAgentRequest(
  id: string,
  body: RunBody,
  deps: RunDeps,
): Promise<AgentResult> {
  if (!isAgentActionId(id)) {
    return {
      ok: false,
      code: 'unknown-action',
      message: `No action ${id}; GET /actions lists them`,
    }
  }
  const spec: AgentActionSpec = agentActions[id]
  const parsed = spec.params.safeParse(body.params ?? {})
  if (!parsed.success) {
    return { ok: false, code: 'invalid-params', message: parsed.error.message }
  }
  if (spec.destructive) {
    if (body.confirm !== true) {
      return {
        ok: false,
        code: 'confirm-required',
        message: `${id} is destructive: send confirm: true, then Isaac approves it in the app`,
      }
    }
    if (!(await deps.ask(id, spec, parsed.data))) {
      return { ok: false, code: 'denied', message: 'Isaac did not approve it' }
    }
  }
  try {
    return await deps.run(id, spec, parsed.data)
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code
    return {
      ok: false,
      code: typeof code === 'string' && /^[a-z][a-z-]*$/.test(code) ? code : 'internal',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
