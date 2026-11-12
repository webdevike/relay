import { contextBridge, ipcRenderer } from 'electron'
import { installDesignGate } from './design-gate'
import { PASSKEY_CHANNEL, type PasskeyPhase } from './guest-channel'

// Design Mode's pointer gate first, before any page script and before the passkey shim, so its
// window capture listeners run ahead of the page's (design-gate.ts).
if (window === window.top) installDesignGate(window, ipcRenderer)

/**
 * Relay's preload for guest pages (persist:browser; the extension host adds its own). It exposes
 * nothing to the page: it wraps `navigator.credentials.create/get` in the page's world so a passkey
 * request (`publicKey`, not the silent autofill `mediation: 'conditional'`) tells main, which
 * offers to open the page in the default browser. Electron shows no passkey UI: such a request
 * otherwise waits with nothing on screen. The notify callback crosses the bridge as a closure,
 * never as a page global.
 */
contextBridge.executeInMainWorld({
  func: (notify: (phase: PasskeyPhase) => void) => {
    // Passkeys need a secure context: a plain http page (a LAN dev server) has no credentials API.
    if (typeof CredentialsContainer === 'undefined') return
    const proto = CredentialsContainer.prototype
    for (const name of ['create', 'get'] as const) {
      const original = proto[name] as (
        this: CredentialsContainer,
        options?: CredentialCreationOptions & CredentialRequestOptions,
      ) => Promise<Credential | null>
      Object.defineProperty(proto, name, {
        configurable: true,
        writable: true,
        value: function (
          this: CredentialsContainer,
          options?: CredentialCreationOptions & CredentialRequestOptions,
        ) {
          const result = original.call(this, options)
          if (options?.publicKey !== undefined && options.mediation !== 'conditional') {
            notify('start')
            result.then(
              (cred) => {
                if (cred) notify('done')
              },
              () => {},
            )
          }
          return result
        },
      })
    }
  },
  args: [(phase: PasskeyPhase) => ipcRenderer.send(PASSKEY_CHANNEL, phase)],
})
