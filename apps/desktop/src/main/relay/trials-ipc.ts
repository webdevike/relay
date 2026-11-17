// Trial mode (@relay/protocol trials.ts): on a host whose welcome lists TRIALS_FEATURE this app asks
// for every trial card and switch message (`trials.get`) on each (re)connect and keeps the latest
// `trials.snapshot` the host pushes, for all chats (the renderer picks a chat's own by thread). A
// pick goes up as `trial.pick` (surface desktop) and an Undo as `trial.undo`; each resolves with
// the host's `trial.picked` / `trial.undone`. The snapshot stays while the host is away, so cards
// keep showing; picks and undos wait for it to come back.
import type { TrialAnswer, TrialsView } from '@evaos/contract'
import { TRIALS_FEATURE, Trial, TrialSwitch } from '@relay/protocol'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { NOT_CONNECTED, type RelayFeatures, type RelayFrames, type RelaySource } from './client'
import { ASK_TIMEOUT_MS, ask } from './mini'

type Frame = Record<string, unknown>

/** Each entry on its own: one the schema refuses is dropped, the rest still show. */
function snapshotOf(f: Frame): Pick<TrialsView, 'trials' | 'switches'> {
  return {
    trials: (Array.isArray(f.trials) ? f.trials : []).flatMap((t: unknown) => {
      const parsed = Trial.safeParse(t)
      return parsed.success ? [parsed.data] : []
    }),
    switches: (Array.isArray(f.switches) ? f.switches : []).flatMap((s: unknown) => {
      const parsed = TrialSwitch.safeParse(s)
      return parsed.success ? [parsed.data] : []
    }),
  }
}

/** The host's answer frame `t` for `key` (`trial` or `switch` = `id`), as the renderer takes it. */
const answerOf =
  (t: string, key: 'trial' | 'switch', id: string) =>
  (f: Frame): TrialAnswer | undefined => {
    if (f.t !== t || f[key] !== id) return undefined
    if (f.ok === true) return { ok: true }
    const error =
      typeof f.error === 'string' && f.error !== '' ? f.error : "Relay couldn't save it."
    return { ok: false, error: error.slice(0, 2000) }
  }

export function registerTrialsIpc(
  ctx: MainContext,
  relay: RelayFrames & RelayFeatures & RelaySource,
): () => void {
  let held: Pick<TrialsView, 'trials' | 'switches'> = { trials: [], switches: [] }
  const view = (): TrialsView => ({ up: relay.hostHas(TRIALS_FEATURE), ...held })
  const send = async (frame: Frame, answer: (f: Frame) => TrialAnswer | undefined) => {
    if (!relay.hostHas(TRIALS_FEATURE)) return { ok: false, error: NOT_CONNECTED }
    try {
      return await ask(relay, frame, answer, ASK_TIMEOUT_MS)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  handle(ctx, 'trials.get', () => view())
  handle(ctx, 'trials.pick', ({ trial, pick }) =>
    send(
      { t: 'trial.pick', trial, pick, surface: 'desktop' },
      answerOf('trial.picked', 'trial', trial),
    ),
  )
  handle(ctx, 'trials.undo', ({ switch: id }) =>
    send({ t: 'trial.undo', switch: id }, answerOf('trial.undone', 'switch', id)),
  )

  if (relay.hostHas(TRIALS_FEATURE)) relay.sendFrame({ t: 'trials.get' })
  const offFrames = relay.onFrame((f) => {
    if (f.t === 'welcome') {
      // Another host's cards are not this one's; one without the feature has none.
      if (relay.hostHas(TRIALS_FEATURE)) relay.sendFrame({ t: 'trials.get' })
      else held = { trials: [], switches: [] }
      emit(ctx, 'trials.changed', view())
      return
    }
    if (f.t !== 'trials.snapshot') return
    held = snapshotOf(f)
    emit(ctx, 'trials.changed', view())
  })
  let up = relay.hostHas(TRIALS_FEATURE)
  const offStatus = relay.onChange(() => {
    if (relay.hostHas(TRIALS_FEATURE) === up) return
    up = !up
    emit(ctx, 'trials.changed', view())
  })
  return () => {
    offFrames()
    offStatus()
  }
}
