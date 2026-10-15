import { app, dialog } from 'electron'
import { createConfigStore } from './config-store'
import type { MainContext } from './context'
import { loadEnv } from './env'
import { registerAppIpc } from './app-ipc'
import { registerBrowser } from './browser'
import { registerChat } from './chat'
import { registerEvaIpc } from './eva-ipc'
import { registerLayoutIpc } from './layout-ipc'
import { installQuitGuard } from './quit-guard'
import { registerSettingsIpc } from './settings-ipc'
import { readLastBackground, registerThemeIpc } from './theme-ipc'
import { createWriteQueue } from './write-queue'
import { installAppMenu } from './menu'
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

  // macOS reports a window as occluded while the screen is locked, on another Space or under
  // a full-screen app. Chromium then backgrounds every WebContentsView in it and never
  // composites a frame, so a window opened in that state stays an empty #17181c box. The shell
  // streams live chat and must paint whenever its window is shown.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

  void app.whenReady().then(() => {
    try {
      installAppMenu()
      const config = createConfigStore(env.configDir)
      const prev = config.readJson<{ launchCount?: number }>('app-state.json', {})
      config.writeJson('app-state.json', {
        launchCount: (prev.launchCount ?? 0) + 1,
        lastLaunch: new Date().toISOString(),
      })

      const { win, shell } = createMainWindow(env, readLastBackground(config))
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

      const guard = installQuitGuard(ctx)
      let quitting = false
      app.on('before-quit', (event) => {
        if (quitting || quitHooks.length === 0 || !guard.approved()) return
        quitting = true
        event.preventDefault()
        const all = Promise.allSettled(quitHooks.map((h) => h()))
        const cap = new Promise((r) => setTimeout(r, 12_000))
        void Promise.race([all, cap]).finally(() => app.exit(0))
      })

      const queue = createWriteQueue()
      registerAppIpc(ctx)
      registerLayoutIpc(ctx, queue)
      registerThemeIpc(ctx, queue)
      registerSettingsIpc(ctx, queue)
      registerEvaIpc(ctx)
      registerChat(ctx)
      registerBrowser(ctx)
      installTestHooks(ctx)
    } catch (e) {
      // A half-started app (no window, no IPC) is worse than a clear failure.
      dialog.showErrorBox('EvaOS', e instanceof Error ? e.message : String(e))
      app.exit(2)
    }
  })

  app.on('window-all-closed', () => app.quit())
}

bootstrap()
