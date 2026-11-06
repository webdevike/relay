// The Skills page's way to the Relay host: each skills.* channel is one loopback JSON call on the
// host's /skills routes (relay apps/linux skills). The routes refuse a remote caller and an Origin
// header, so they work only against the host on this Mac, and Node's fetch sends no Origin.
import type { SkillDetail, SkillList, SkillRow } from '@evaos/contract'
import { handle } from '../ipc/handle'
import type { MainContext } from '../context'
import { refusal } from './canvas-live-agent'
import type { RelayCanvas } from './client'
import { bearer } from './device'

/** How long the host may take to answer (a save writes the file; a list reads every skill). */
const TIMEOUT_MS = 15_000

/** Who Isaac is in a skill's live document: the host's `HUMAN_COLOR` face, as the Canvas page. */
const HUMAN = { name: 'Isaac', color: '#0ea5e9' } as const

const NO_HOST = 'Skills needs the Relay host running on this Mac.'
const REMOTE_HOST =
  'Skills is not supported with a remote Relay host: it needs the host on this Mac.'

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** The host's loopback origin, or why there is none (no host, or one on another machine). */
function reach(relay: Pick<RelayCanvas, 'canvasOrigin'>): { origin: string } | { reason: string } {
  const raw = relay.canvasOrigin()
  if (raw === null) return { reason: NO_HOST }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { reason: NO_HOST }
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return { reason: REMOTE_HOST }
  return { origin: `http://127.0.0.1${url.port === '' ? '' : `:${url.port}`}` }
}

interface Answer {
  status: number
  ok: boolean
  statusText: string
  text: string
}

/** One call to the host. A network failure throws `skills-unavailable`. */
async function ask(
  post: typeof fetch,
  origin: string,
  token: string | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Answer> {
  try {
    const res = await post(`${origin}${path}`, {
      method,
      ...(method === 'POST'
        ? { headers: { 'content-type': 'application/json', ...bearer(token) }, body: JSON.stringify(body ?? {}) }
        : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: res.status, ok: res.ok, statusText: res.statusText, text: await res.text() }
  } catch (e) {
    return fail(
      'skills-unavailable',
      `Couldn't reach Relay: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

const reason = (a: Answer): string => refusal(a.status, a.statusText, a.text)

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return fail('host-refused', 'Relay answered with something that is not JSON')
  }
}

export function registerSkillsIpc(
  ctx: MainContext,
  relay: Pick<RelayCanvas, 'canvasOrigin' | 'hostToken'>,
  post: typeof fetch = fetch,
): void {
  const originOf = (): string => {
    const r = reach(relay)
    return 'origin' in r ? r.origin : fail('skills-unavailable', r.reason)
  }
  const path = (name: string, rest = ''): string => `/skills/${encodeURIComponent(name)}${rest}`
  /** A 2xx answer's JSON, else a `host-refused` with the host's reason. */
  const okJson = (a: Answer): unknown => (a.ok ? parse(a.text) : fail('host-refused', reason(a)))

  handle(ctx, 'skills.list', async (): Promise<SkillList> => {
    const r = reach(relay)
    const none = (error: string): SkillList => ({
      skills: [],
      assistants: [],
      available: false,
      error: error.slice(0, 500),
    })
    if ('reason' in r) return none(r.reason)
    try {
      const a = await ask(post, r.origin, null, 'GET', '/skills')
      if (!a.ok) return none(reason(a))
      return { ...(parse(a.text) as Omit<SkillList, 'available'>), available: true }
    } catch (e) {
      return none(e instanceof Error ? e.message : String(e))
    }
  })

  handle(ctx, 'skills.detail', async ({ name }) => {
    const a = await ask(post, originOf(), relay.hostToken(), 'GET', path(name))
    if (a.status === 404) fail('not-found', reason(a))
    return okJson(a) as SkillDetail
  })

  handle(ctx, 'skills.access', async ({ name, enabled }) => {
    const a = await ask(post, originOf(), relay.hostToken(), 'POST', path(name, '/access'), { enabled })
    return okJson(a) as SkillRow
  })

  handle(ctx, 'skills.open', async ({ name }) => {
    const origin = originOf()
    const a = await ask(post, origin, relay.hostToken(), 'POST', path(name, '/open'), {
      user: { name: HUMAN.name, color: HUMAN.color },
    })
    const token = (okJson(a) as { token?: unknown } | null)?.token
    if (typeof token !== 'string' || token === '') {
      fail('host-refused', 'Relay did not give a token for that skill')
    }
    return {
      serverUrl: `${origin.replace(/^http/, 'ws')}${path(name)}`,
      room: 'ws' as const,
      token,
      user: { name: HUMAN.name, color: HUMAN.color, kind: 'human' as const },
    }
  })

  handle(ctx, 'skills.save', async ({ name, force }) => {
    const a = await ask(
      post,
      originOf(),
      relay.hostToken(),
      'POST',
      path(name, '/save'),
      force === undefined ? {} : { force },
    )
    if (a.ok) return { status: 'saved' as const }
    if (a.status === 409 && reason(a) === 'changed-on-disk') {
      return { status: 'changed-on-disk' as const }
    }
    return fail('host-refused', reason(a))
  })

  handle(ctx, 'skills.reload', async ({ name }) => {
    const a = await ask(post, originOf(), relay.hostToken(), 'POST', path(name, '/reload'), {})
    okJson(a)
    return { reloaded: true as const }
  })
}
