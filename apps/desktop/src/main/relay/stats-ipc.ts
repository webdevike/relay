// Settings > Usage: the Relay Host's omp stats. The host computes them in the background and keeps
// one snapshot; `stats.get` asks for it (answered at once from the host's memory) and every later
// snapshot the host pushes, or the host coming or going, goes out as `stats.changed`.
import { StatsSnapshotSchema, type StatsSnapshot, type StatsView } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayFeatures, RelayFrames, RelaySource } from './client'
import { ASK_TIMEOUT_MS, ask } from './mini'

/** `welcome.features` entry of a host that answers `stats.get` (protocol STATS_FEATURE). */
const STATS_FEATURE = 'stats'

export const NO_HOST = 'Usage needs the Relay Host. It is not connected right now.'
export const OLD_HOST =
  'This Relay Host is too old to report usage. Update the Relay Host to see it.'

const snapshotOf = (f: Record<string, unknown>): StatsSnapshot | undefined => {
  if (f.t !== 'stats.snapshot') return undefined
  const parsed = StatsSnapshotSchema.safeParse(f.stats)
  return parsed.success ? parsed.data : undefined
}

export function registerStatsIpc(
  ctx: MainContext,
  relay: RelayFrames & RelayFeatures & RelaySource,
): () => void {
  /** Why there are no stats, or null when the host answers them. */
  const unavailable = (): string | null =>
    relay.sessions() === null ? NO_HOST : relay.hostHas(STATS_FEATURE) ? null : OLD_HOST

  handle(ctx, 'stats.get', async (): Promise<StatsView> => {
    const reason = unavailable()
    if (reason !== null) return { stats: null, unavailable: reason }
    const stats = await ask(relay, { t: 'stats.get' }, snapshotOf, ASK_TIMEOUT_MS)
    return { stats, unavailable: null }
  })

  const offFrames = relay.onFrame((f) => {
    const stats = snapshotOf(f)
    if (stats !== undefined) emit(ctx, 'stats.changed', { stats, unavailable: null })
  })
  // The page asks again when the host comes up; it shows why while there is none.
  let last = unavailable()
  const offStatus = relay.onChange(() => {
    const now = unavailable()
    if (now === last) return
    last = now
    emit(ctx, 'stats.changed', { stats: null, unavailable: now })
  })
  return () => {
    offFrames()
    offStatus()
  }
}
