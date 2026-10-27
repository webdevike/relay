import { z } from 'zod'
import { SwitchAppSchema, type SwitchApp } from '@evaos/contract'
import { APP_SWITCH_ORIGIN } from '@evaos/browser-core/app-switch'

/** The browser session's fetch: the switch reports the partition cookie's app as active. */
export type SessionFetch = (url: string, init: RequestInit) => Promise<Response>

const TIMEOUT_MS = 5000
const AppsSchema = z.array(SwitchAppSchema)
const ErrorBodySchema = z.object({ error: z.string() })

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * The switch's registered apps as one tab sees them: `tabApp` (the tab's own app, see
 * tab-app-cookies.ts) is the active one when the switch still has it; otherwise the switch's
 * answer stands, which follows the partition cookie the tab then also sends.
 */
export async function listSwitchApps(fetch: SessionFetch, tabApp?: string): Promise<SwitchApp[]> {
  let res: Response
  try {
    res = await fetch(`${APP_SWITCH_ORIGIN}/__apps`, {
      method: 'GET',
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
    throw fail('app-switch-error', `The app switch refused: ${why}.`)
  }
  const parsed = AppsSchema.safeParse(body)
  // An older switch has no /__apps: the request falls through to the app's own HTML.
  if (!parsed.success) {
    throw fail(
      'app-switch-outdated',
      `The app switch on ${APP_SWITCH_ORIGIN} has no app list. Restart it: bun work/ecard-app-switch.ts serve.`,
    )
  }
  const apps = parsed.data
  if (!tabApp || !apps.some((a) => a.id === tabApp)) return apps
  return apps.map((a) => ({ ...a, active: a.id === tabApp }))
}
