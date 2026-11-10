import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import type { RelayLink } from './client'

/** The host acks a sign-in once the browser tool typed the credentials and the page settled (it gives the tool 60 s). */
export const SIGNIN_TIMEOUT_MS = 70_000

/**
 * `signin.submit`: the sign-in card's username and password form. Sent to the host as
 * `assistant.signin`, which types them into the login page in Eva's contained browser. The
 * credentials pass through here only; nothing logs or keeps them. A refusal reaches the card
 * as the host's message (the page's own error, or that Relay is not connected).
 */
export function registerSigninIpc(ctx: MainContext, relay: RelayLink): void {
  handle(ctx, 'signin.submit', async (input) => {
    await relay.command({ kind: 'assistant.signin', ...input }, SIGNIN_TIMEOUT_MS)
    return {}
  })
}
