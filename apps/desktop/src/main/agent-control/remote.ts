// Remote control through the Relay Host (relay packages/protocol CONTROL_FEATURE): agents on the
// Mini reach this app on whichever Mac Isaac is using. On a host whose welcome lists "control" this
// app says it can be driven (`control.presence`: its name, how long since Isaac used the window,
// the page in front), again after input, a page change or a focus change. The host's `control.req`
// runs through `run`, the same path as a request to the loopback control API (registry, params,
// confirm and Isaac's approval, scope), and goes back as `control.res` with the same rid.
//
// Only the host's authenticated connection delivers frames here: no other device can send one
// (`control.req` is not a client frame), and nothing else listens for it.
import { z } from 'zod'
import type { AgentResult } from '@evaos/contract'
import type { RelayFrames } from '../relay/client'
import type { RunBody } from './server'

export const CONTROL_FEATURE = 'control'
/** Input more often than this goes out once (the host only orders Macs by it). */
export const PRESENCE_EVERY_MS = 1000

export interface PresenceState {
  name: string
  instance: string
  idleMs: number | null
  page: string | null
  focused: boolean
  remote: boolean
}

export interface RemoteControlDeps {
  frames: RelayFrames
  /** One request through the control API's runner. */
  run(id: string, body: RunBody): Promise<AgentResult>
  /** The action catalog, for `@actions`. */
  catalog(): unknown
  presence(): PresenceState
  now?: () => number
}

export interface RemoteControl {
  /** Isaac used the window, the page changed or focus moved: tell the host (throttled). */
  changed(): void
  stop(): void
}

const ReqSchema = z.object({
  t: z.literal('control.req'),
  rid: z.string().min(1).max(64),
  action: z.string().min(1).max(65),
  params: z.unknown().optional(),
  confirm: z.boolean().optional(),
  scope: z.string().min(1).max(4096).optional(),
})

/** The host drops a connection over a frame its schema refuses: keep codes and messages in bounds. */
function bounded(r: AgentResult): AgentResult {
  if (r.ok) return r
  return { ok: false, code: r.code.slice(0, 64) || 'internal', message: r.message.slice(0, 4000) }
}

export function startRemoteControl(deps: RemoteControlDeps): RemoteControl {
  const now = deps.now ?? Date.now
  let enabled = false
  let sentAt = Number.NEGATIVE_INFINITY
  let timer: NodeJS.Timeout | undefined

  const sendPresence = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (!enabled) return
    sentAt = now()
    deps.frames.sendFrame({ t: 'control.presence', ...deps.presence() })
  }

  const answer = async (req: z.output<typeof ReqSchema>): Promise<void> => {
    let result: AgentResult
    if (req.action === '@actions') result = { ok: true, value: deps.catalog() }
    else {
      const body: RunBody = {
        ...(req.params === undefined ? {} : { params: req.params }),
        ...(req.confirm === undefined ? {} : { confirm: req.confirm }),
        ...(req.scope === undefined ? {} : { scope: req.scope }),
      }
      try {
        result = await deps.run(req.action, body)
      } catch (e) {
        result = {
          ok: false,
          code: 'internal',
          message: e instanceof Error ? e.message : String(e),
        }
      }
    }
    deps.frames.sendFrame({ t: 'control.res', rid: req.rid, result: bounded(result) })
  }

  const off = deps.frames.onFrame((f) => {
    if (f.t === 'welcome') {
      enabled = Array.isArray(f.features) && f.features.includes(CONTROL_FEATURE)
      sendPresence()
      return
    }
    if (f.t !== 'control.req') return
    const req = ReqSchema.safeParse(f)
    if (req.success) void answer(req.data)
  })

  return {
    changed() {
      if (!enabled || timer) return
      const wait = sentAt + PRESENCE_EVERY_MS - now()
      if (wait <= 0) sendPresence()
      else timer = setTimeout(sendPresence, wait)
    },
    stop() {
      off()
      clearTimeout(timer)
      timer = undefined
    },
  }
}
