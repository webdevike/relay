import { z } from 'zod'
import { SwitchAppIdSchema, SwitchAppSchema, type SwitchApp } from '@evaos/contract'
import { APP_SWITCH_ORIGIN } from '@evaos/browser-core/app-switch'

/** The browser session's fetch, so the switch sees (and sets) the tab's `ecard_app` cookie. */
export type SessionFetch = (url: string, init: RequestInit) => Promise<Response>

const TIMEOUT_MS = 5000
const AppsSchema = z.array(SwitchAppSchema)
const SwitchedSchema = z.object({ active: SwitchAppIdSchema })
const ErrorBodySchema = z.object({ error: z.string() })

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

async function call<T>(
  fetch: SessionFetch,
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${APP_SWITCH_ORIGIN}${path}`, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    throw fail(
      'app-switch-down',
      `The app switch on ${APP_SWITCH_ORIGIN} is not answering (${why}).`,
    )
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const why = ErrorBodySchema.safeParse(body).data?.error ?? `HTTP ${res.status}`
    throw fail(
      res.status === 404 ? 'unknown-app' : 'app-switch-error',
      `The app switch refused: ${why}.`,
    )
  }
  const parsed = schema.safeParse(body)
  // An older switch has no /__apps: the request falls through to the app's own HTML.
  if (!parsed.success) {
    throw fail(
      'app-switch-outdated',
      `The app switch on ${APP_SWITCH_ORIGIN} has no app list. Restart it: bun work/ecard-app-switch.ts serve.`,
    )
  }
  return parsed.data
}

export function listSwitchApps(fetch: SessionFetch): Promise<SwitchApp[]> {
  return call(fetch, '/__apps', { method: 'GET' }, AppsSchema)
}

/** Sets the switch's cookie in the browser session; resolves with the app it now serves. */
export async function selectSwitchApp(fetch: SessionFetch, id: string): Promise<string> {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  }
  return (await call(fetch, '/__switch', init, SwitchedSchema)).active
}
