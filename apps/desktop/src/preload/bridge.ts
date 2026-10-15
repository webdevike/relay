import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@evaos/contract'

export interface IpcLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

/** Builds window.eva over an ipcRenderer-like object. Unknown channels never reach it. */
export function createEvaBridge(ipc: IpcLike) {
  return {
    invoke(channel: string, input: unknown): Promise<unknown> {
      if (!INVOKE_CHANNELS.includes(channel)) {
        return Promise.reject(new Error(`unknown channel: ${channel}`))
      }
      return ipc.invoke(channel, input)
    },
    on(channel: string, cb: (payload: unknown) => void): () => void {
      if (!EVENT_CHANNELS.includes(channel)) throw new Error(`unknown channel: ${channel}`)
      // The IpcRendererEvent never reaches the page.
      const listener = (_e: unknown, payload: unknown): void => cb(payload)
      ipc.on(channel, listener)
      return () => {
        ipc.removeListener(channel, listener)
      }
    },
  }
}
