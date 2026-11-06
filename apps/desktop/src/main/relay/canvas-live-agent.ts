// The canvas.live agent action: an omp session takes its chat onto a board with Isaac. The Relay
// host runs the room (relay apps/linux canvas); this asks it on its loopback JSON route with the
// caller's identity from the request's scope (relay-ctl sends the caller's own: `agent:<id>` for
// an assistant thread, else its session file) and answers what the host answers.
import type { AgentParams, AgentRunners } from '@evaos/contract'
import type { RelayCanvas } from './client'
import { bearer } from './device'

/** How long the host may take to open a room (it seeds the board and starts the agent). */
const START_TIMEOUT_MS = 30_000

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** Who asks for the room, as the host's `caller`: an assistant's thread, or a chat's session file. */
export function canvasCaller(
  scope: string | undefined,
): { assistant: string } | { sessionFile: string } {
  if (scope === undefined) {
    fail(
      'no-scope',
      'canvas.live starts from the calling session: run it from an omp session (relay-ctl sends it) or pass --scope',
    )
  }
  const agent = /^(?:page:)?agent:([a-z][a-z0-9-]*)$/.exec(scope)?.[1]
  if (agent !== undefined) return { assistant: agent }
  const file = scope.startsWith('chat:') ? scope.slice('chat:'.length) : scope
  if (!file.startsWith('/') || !file.endsWith('.jsonl')) {
    fail('bad-scope', `No chat session for scope ${scope}: pass agent:<id> or a session file`)
  }
  return { sessionFile: file }
}

/** The host's refusal as one line: its JSON `error` (or `message`), else the HTTP status. */
export function refusal(status: number, statusText: string, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null) {
      const { error, message } = parsed as { error?: unknown; message?: unknown }
      if (typeof error === 'string' && error !== '') return error
      if (typeof message === 'string' && message !== '') return message
    }
  } catch {
    // Not JSON: the status says it.
  }
  return `Relay answered ${status} ${statusText}`.trim()
}

/**
 * Asks the host to start (or rejoin) a canvas session: `POST /canvas/sessions` with `body` (the
 * caller and what the session is for), answering the host's JSON. Throws with a code and the host's
 * one-line reason.
 */
export async function startCanvasSession(
  relay: Pick<RelayCanvas, 'canvasOrigin' | 'hostToken'>,
  body: Record<string, unknown>,
  post: typeof fetch = fetch,
): Promise<unknown> {
  const origin = relay.canvasOrigin()
  if (origin === null)
    fail('relay-unavailable', "Relay isn't running, so there is no host to hold the canvas.")
  let res: Response
  try {
    res = await post(`${origin}/canvas/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(relay.hostToken()) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
    })
  } catch (e) {
    fail('relay-unavailable', `Couldn't reach Relay: ${e instanceof Error ? e.message : String(e)}`)
  }
  const text = await res.text()
  if (!res.ok) fail('host-refused', refusal(res.status, res.statusText, text))
  try {
    return JSON.parse(text) as unknown
  } catch {
    fail('host-refused', 'Relay answered with something that is not JSON')
  }
}

export function canvasLiveRunners(
  relay: Pick<RelayCanvas, 'canvasOrigin' | 'hostToken'>,
  post: typeof fetch = fetch,
): Pick<AgentRunners<'main'>, 'canvas.live'> {
  return {
    'canvas.live': async (params: AgentParams<'canvas.live'>) => {
      const { scope, ...ask } = params
      return startCanvasSession(relay, { ...ask, caller: canvasCaller(scope) }, post)
    },
  }
}
