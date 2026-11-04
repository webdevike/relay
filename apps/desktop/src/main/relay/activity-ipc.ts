import type { ActivityView } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayActivity, RelayArtifacts, RelaySource } from './client'

/**
 * `activity.watch` answers with the host's activity list and asks for it (now and after every
 * reconnect); `activity.changed` follows each snapshot the host pushes. The list is the host's, so
 * the Mini and the MacBook show the same rows.
 */
export function registerActivityIpc(
  ctx: MainContext,
  relay: RelaySource & RelayArtifacts & RelayActivity,
): () => void {
  const view = (): ActivityView => ({ up: relay.artifactsUp(), items: [...relay.activity()] })
  handle(ctx, 'activity.watch', () => {
    relay.watchActivity()
    return view()
  })
  const offActivity = relay.onActivity(() => emit(ctx, 'activity.changed', view()))
  let up = relay.artifactsUp()
  const offStatus = relay.onChange(() => {
    if (relay.artifactsUp() === up) return
    up = !up
    emit(ctx, 'activity.changed', view())
  })
  return () => {
    offActivity()
    offStatus()
  }
}
