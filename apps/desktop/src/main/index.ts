import { app, dialog, screen } from 'electron'
import { join } from 'node:path'
import { APP_NAME, moveLegacyConfig } from './app-name'
import { createConfigStore } from './config-store'
import type { MainContext } from './context'
import { loadEnv } from './env'
import { registerAppIpc } from './app-ipc'
import { registerBrowser } from './browser'
import { registerChat } from './chat'
import { registerEvaIpc } from './eva-ipc'
import { registerCanvasIpc } from './canvas/canvas-ipc'
import { registerLayoutIpc } from './layout-ipc'
import { installQuitGuard } from './quit-guard'
import { registerSettingsIpc } from './settings-ipc'
import { readLastBackground, registerThemeIpc } from './theme-ipc'
import { createWriteQueue } from './write-queue'
import { installAppMenu } from './menu'
import { installWriteGuard } from './eva/write-guard'
import { startEvaWatch } from './eva/watch'
import { installTestHooks } from './test-hooks'
import { WINDOW_MIN, createMainWindow } from './window'
import { WINDOW_STATE_FILE, restorableWindow, trackWindowState } from './window-state'
import { registerExperimentsIpc } from './experiments/experiments-ipc'
import {
  registerWidgetFrames,
  registerWidgetMedia,
  registerWidgetSchemes,
} from './chat/widget-protocols'
import { registerUsageIpc } from './usage/usage-ipc'
import { registerLinearIpc } from './linear/linear-ipc'
import { registerRoomsIpc } from './rooms/rooms-ipc'
import { registerFilesIpc } from './files/files-ipc'
import { registerAgentControl } from './agent-control'

function bootstrap(): void {
  let env
  try {
    env = loadEnv(app)
  } catch (e) {
    dialog.showErrorBox(APP_NAME, e instanceof Error ? e.message : String(e))
    app.exit(2)
    return
  }

  app.setName(APP_NAME)
  moveLegacyConfig(env.legacyConfigDir, env.configDir)
  // Chromium profile, persist:browser and extension storage live under the config dir.
  app.setPath('userData', env.configDir)
  installWriteGuard(env)
  registerWidgetSchemes()

  // macOS reports a window as occluded while the screen is locked, on another Space or under
  // a full-screen app. Chromium then backgrounds every WebContentsView in it and never
  // composites a frame, so a window opened in that state stays an empty #17181c box. The shell
  // streams live chat and must paint whenever its window is shown.
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  // Eva drives the running app over CDP (Playwright connectOverCDP); Chromium binds it to
  // 127.0.0.1 only. Any local process can attach, which Isaac accepted on 2026-10-22.
  if (env.cdpPort) app.commandLine.appendSwitch('remote-debugging-port', String(env.cdpPort))

  // Test and proof runs happen while Isaac works on the same Mac: run as an accessory app (no
  // Dock icon, never becomes the active app) so launches don't steal focus. window.ts keeps the
  // window itself transparent, click-through and inactive.
  if (env.hiddenWindow && process.platform === 'darwin') app.setActivationPolicy('accessory')

  void app.whenReady().then(async () => {
    try {
      if (process.platform === 'darwin' && !env.hiddenWindow) {
        app.dock?.setIcon(join(app.getAppPath(), 'resources/icon.png'))
      }
      installAppMenu()
      const config = createConfigStore(env.configDir)
      const prev = config.readJson<{ launchCount?: number }>('app-state.json', {})
      config.writeJson('app-state.json', {
        launchCount: (prev.launchCount ?? 0) + 1,
        lastLaunch: new Date().toISOString(),
      })

      const savedWindow = restorableWindow(
        config.readJson<unknown>(WINDOW_STATE_FILE, null),
        screen.getAllDisplays().map((d) => d.workArea),
        WINDOW_MIN,
      )
      const { win, shell } = createMainWindow(env, readLastBackground(config), savedWindow)
      trackWindowState(win, config)
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
      const chat = registerChat(ctx, queue)
      registerExperimentsIpc(ctx)
      registerWidgetMedia(ctx)
      registerWidgetFrames()
      const evaWatch = startEvaWatch(ctx)
      ctx.onBeforeQuit(() => evaWatch.close())
      registerCanvasIpc(ctx)
      registerUsageIpc(ctx)
      registerLinearIpc(ctx)
      registerRoomsIpc(ctx)
      registerFilesIpc(ctx, chat)
      registerBrowser(ctx)
      registerAgentControl(ctx)
      installTestHooks(ctx)
    } catch (e) {
      // A half-started app (no window, no IPC) is worse than a clear failure.
      dialog.showErrorBox(APP_NAME, e instanceof Error ? e.message : String(e))
      app.exit(2)
    }
  })

  app.on('window-all-closed', () => app.quit())
}

bootstrap()
