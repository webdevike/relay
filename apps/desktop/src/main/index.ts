import { app, screen } from 'electron'
import { join } from 'node:path'
import { UPDATE_RESTART_EXIT_CODE } from '@evaos/contract'
import { APP_NAME, appName, moveLegacyConfig } from './app-name'
import { createConfigStore } from './config-store'
import type { MainContext } from './context'
import { loadEnv } from './env'
import { registerAboutIpc, registerAppIpc } from './app-ipc'
import { registerBrowser } from './browser'
import { registerChat } from './chat'
import { registerEvaIpc } from './eva-ipc'
import { registerCanvasIpc } from './canvas/canvas-ipc'
import { registerLayoutIpc } from './layout-ipc'
import { registerDraftsIpc } from './drafts-ipc'
import { installQuitGuard } from './quit-guard'
import { registerSettingsIpc } from './settings-ipc'
import { registerLinksIpc } from './links/links-ipc'
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
import { linearReader, registerLinearIpc } from './linear/linear-ipc'
import { registerReviewsIpc } from './reviews/reviews-ipc'
import { createHostApprove } from './relay/host-approve'
import { createPrSource, toolRunner } from './context-popover/pr-source'
import { startStatusReader } from './relay/artifacts-status'
import { registerRoomsIpc } from './rooms/rooms-ipc'
import { registerFilesIpc } from './files/files-ipc'
import { registerTerminalIpc } from './terminal/terminal-ipc'
import { registerAgentControl } from './agent-control'
import { reportFatal } from './fatal'
import { registerUpdate } from './update'
import { registerContext } from './context-popover'
import { createPackagedUpdater, type PackagedUpdater } from './update/packaged'
import { assistExecutable, startAssist } from './assist'
import { registerSetup } from './setup'
import { registerConnections } from './connections'
import { listenForDeepLinks } from './deep-links'

/** Marks that the packaged app registered itself as a login item once. */
const LOGIN_ITEM_FILE = 'login-item.json'

// A packaged app relaunched by the updater (or started from a terminal that closed) can lose its
// stdout/stderr pipe; a later console.log then throws EPIPE and Electron shows a fatal dialog.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e
  })
}

function bootstrap(): void {
  let env
  try {
    env = loadEnv(app)
  } catch (e) {
    // No env yet: read the hidden flag straight from the environment.
    reportFatal(
      process.env.EVAOS_HIDDEN_WINDOW === '1',
      APP_NAME,
      e instanceof Error ? e.message : String(e),
    )
    app.exit(2)
    return
  }

  const name = appName(env.instance)
  app.setName(name)
  if (env.instance === 'dev') {
    console.warn(`Relay Dev: config ${env.configDir}, CDP ${env.cdpPort ?? 'off'}`)
  }
  moveLegacyConfig(env.legacyConfigDir, env.configDir)
  // Chromium profile, persist:browser and extension storage live under the config dir.
  app.setPath('userData', env.configDir)
  installWriteGuard(env)
  registerWidgetSchemes()
  // relay:// links from outside the app; only the packaged live app claims the scheme.
  const deepLinks = listenForDeepLinks(
    app.isPackaged && env.instance === 'stable' && !env.hiddenWindow && !env.e2e,
  )

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
      installAppMenu(name)
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
      // 75 once Isaac (or the idle auto-restart) restarts into a pending update; the
      // supervisor relaunches the stable app on 75 only. Every other quit exits 0.
      let exitCode = 0
      let quitting = false
      app.on('before-quit', (event) => {
        if (quitting || quitHooks.length === 0 || !guard.approved()) return
        quitting = true
        event.preventDefault()
        const all = Promise.allSettled(quitHooks.map((h) => h()))
        const cap = new Promise((r) => setTimeout(r, 12_000))
        void Promise.race([all, cap]).finally(() => app.exit(exitCode))
      })
      // A quit with no hooks ends without app.exit; carry the restart code through it too.
      app.on('will-quit', (event) => {
        if (exitCode === 0) return
        event.preventDefault()
        app.exit(exitCode)
      })
      let packagedUpdater: PackagedUpdater | undefined
      let restarting = false
      const restartForUpdate = (): void => {
        if (restarting || quitting) return
        restarting = true
        // Unsaved edits ask first; Cancel keeps the app open and the update pending.
        void guard.guardedClose().then((ok) => {
          restarting = false
          if (!ok) return
          // A packaged app swaps its staged bundle in and reopens itself once this process is gone.
          packagedUpdater?.scheduleSwap()
          exitCode = UPDATE_RESTART_EXIT_CODE
          app.quit()
        })
      }

      const queue = createWriteQueue()
      registerAppIpc(ctx)
      deepLinks.attach(ctx)
      registerSetup(ctx)
      registerLayoutIpc(ctx, queue)
      registerDraftsIpc(ctx)
      registerThemeIpc(ctx, queue)
      registerSettingsIpc(ctx, queue)
      registerLinksIpc(ctx, queue)
      registerEvaIpc(ctx)
      const chat = registerChat(ctx, queue)
      const experiments = registerExperimentsIpc(ctx)
      const run = toolRunner(ctx)
      // One gh PR cache for the context popover and the Artifacts status reader.
      const prs = createPrSource(ctx, run)
      const linear = linearReader(ctx.env.evaRoot, ctx.env.configDir)
      registerContext(ctx, queue, chat, experiments, run, prs)
      // Linear and PR status polling is Isaac's eCard workflow; a starter home never starts it.
      if (ctx.env.profile === 'eva') {
        const stopStatuses = startStatusReader({
          relay: chat.artifacts,
          pr: (repo, number) => prs.get(repo, number, false),
          onPrChange: (cb) => prs.onChange(cb),
          linear: prs.allowed ? linear : null,
        })
        ctx.onBeforeQuit(async () => stopStatuses())
      }
      registerWidgetMedia(ctx)
      registerWidgetFrames()
      const evaWatch = startEvaWatch(ctx)
      ctx.onBeforeQuit(() => evaWatch.close())
      registerCanvasIpc(ctx)
      registerUsageIpc(ctx, chat.mini)
      registerLinearIpc(ctx, linear)
      registerReviewsIpc(ctx, run, ctx.env.relayRemote ? createHostApprove(chat.frames) : null)
      registerRoomsIpc(ctx)
      registerFilesIpc(ctx, chat)
      registerTerminalIpc(ctx, chat)
      registerBrowser(ctx)
      const update = registerUpdate(ctx, {
        chatWorking: () => chat.anyWorking(),
        restart: restartForUpdate,
        checkNow: async () => (await packagedUpdater?.checkNow()) ?? 'unavailable',
        changelog: async () => (await packagedUpdater?.changelog()) ?? [],
      })
      registerAboutIpc(ctx, chat.hostInfo)
      if (app.isPackaged) {
        packagedUpdater = createPackagedUpdater({
          configDir: env.configDir,
          appPath: app.getAppPath(),
          execPath: process.execPath,
          pid: process.pid,
          offer: (u) => update.offer(u),
          log: (m) => console.warn(m),
        })
        packagedUpdater.start()
        // Relay Assist runs as Relay's child so its privacy grants are Relay's (assist.ts).
        const assist = startAssist(assistExecutable(process.resourcesPath), (m) => console.warn(m))
        if (assist) ctx.onBeforeQuit(() => assist.stop())
        // The packaged app opens at login (and starts Assist); registered once, so turning it
        // off in System Settings > General > Login Items stays off.
        if (!config.readJson(LOGIN_ITEM_FILE, false)) {
          app.setLoginItemSettings({ openAtLogin: true })
          config.writeJson(LOGIN_ITEM_FILE, true)
        }
      }
      const connections = registerConnections(ctx, chat.hostInfo)
      registerAgentControl(ctx, update, chat.artifacts, chat.canvas, chat.studio, connections)
      installTestHooks(ctx)
    } catch (e) {
      // A half-started app (no window, no IPC) is worse than a clear failure.
      reportFatal(env.hiddenWindow, name, e instanceof Error ? e.message : String(e))
      app.exit(2)
    }
  })

  app.on('window-all-closed', () => app.quit())
}

bootstrap()
