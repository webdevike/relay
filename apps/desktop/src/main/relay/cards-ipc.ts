import type { DismissedCardsView } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayCards, RelaySource } from './client'

/**
 * `cards.dismissed.get` / `cards.dismiss`, and `cards.dismissed.changed` after each host snapshot
 * and when the host that keeps the set comes up or goes down.
 */
export function registerCardsIpc(ctx: MainContext, relay: RelaySource & RelayCards): () => void {
  const view = (): DismissedCardsView => {
    const up = relay.cardsUp()
    return { up, ids: up ? relay.dismissedCards() : null }
  }
  handle(ctx, 'cards.dismissed.get', () => view())
  handle(ctx, 'cards.dismiss', ({ id, on }) => ({ sent: relay.dismissCard(id, on) }))
  const offCards = relay.onCards(() => emit(ctx, 'cards.dismissed.changed', view()))
  let up = relay.cardsUp()
  const offStatus = relay.onChange(() => {
    if (relay.cardsUp() === up) return
    up = !up
    emit(ctx, 'cards.dismissed.changed', view())
  })
  return () => {
    offCards()
    offStatus()
  }
}
