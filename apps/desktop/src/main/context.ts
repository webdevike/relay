import type { BaseWindow, WebContentsView } from 'electron'
import type { ConfigStore } from './config-store'
import type { Env } from './env'

export interface MainContext {
  env: Env
  win: BaseWindow
  shell: WebContentsView
  config: ConfigStore
  /** Hooks run (with a 12 s cap) before the app exits. */
  onBeforeQuit(fn: () => Promise<void>): void
}
