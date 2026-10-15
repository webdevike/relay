import { app, dialog } from 'electron'
import { createConfigStore } from './config-store'
import type { MainContext } from './context'
import { loadEnv } from './env'
import { registerAppIpc } from './app-ipc'
import { registerBrowser } from './browser'
import { registerChat } from './chat'
import { installWriteGuard } from './eva/write-guard'
import { installTestHooks } from './test-hooks'
import { createMainWindow } from './window'

function bootstrap(): void {
  let env
  try {
    env = loadEnv(app)
  } catch (e) {
    dialog.showErrorBox('EvaOS', e instanceof Error ? e.message : String(e))
    app.exit(2)
    return
  }

  // Chromium profile, persist:browser and extension storage live under the config dir.
  app.setPath('userData', env.configDir)
  installWriteGuard(env)

  void app.whenReady().then(() => {
    const config = createConfigStore(env.configDir)
    const prev = config.readJson<{ launchCount?: number }>('app-state.json', {})
    config.writeJson('app-state.json', {
      launchCount: (prev.launchCount ?? 0) + 1,
      lastLaunch: new Date().toISOString(),
    })

    const { win, shell } = createMainWindow(env)
    const quitHooks: Array<() => Promise<void>> = []
    const ctx: MainContext = {
      env,
      win,
      shell,
      config,
      onBeforeQuit: (fn) => {
        quitHooks.push(fn)
      },
    }

    let quitting = false
    app.on('before-quit', (event) => {
      if (quitting || quitHooks.length === 0) return
      quitting = true
      event.preventDefault()
      const all = Promise.allSettled(quitHooks.map((h) => h()))
      const cap = new Promise((r) => setTimeout(r, 12_000))
      void Promise.race([all, cap]).finally(() => app.exit(0))
    })

    registerAppIpc(ctx)
    registerChat(ctx)
    registerBrowser(ctx)
    installTestHooks(ctx)
  })

  app.on('window-all-closed', () => app.quit())
}

bootstrap()
