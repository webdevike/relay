/**
 * Guest page to main: the page asked for a passkey (`start`) or got one (`done`). Sent by the guest
 * preload (guest.ts); main shows or clears the "Passkeys don't work here" bar for that tab.
 */
export const PASSKEY_CHANNEL = 'relay:guest-passkey'

export type PasskeyPhase = 'start' | 'done'
