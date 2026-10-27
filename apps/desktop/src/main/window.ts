import { BaseWindow, WebContentsView, dialog } from 'electron'
import * as path from 'node:path'
import type { Env } from './env'
import { APP_NAME } from './app-name'
import { isAppUrl } from './app-url'
import type { WindowState } from './window-state'

export { isAppUrl }

const rendererDir = path.join(__dirname, '../renderer')

export const WINDOW_MIN = { width: 760, height: 720 }

/** `saved` is the last run's window (window-state.ts), already checked against the displays. */
export function createMainWindow(
  env: Env,
  backgroundColor = '#181817',
  saved: WindowState | null = null,
): { win: BaseWindow; shell: WebContentsView } {
  const win = new BaseWindow({
    ...(saved ? saved.bounds : { width: 1280, height: 800 }),
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    titleBarStyle: 'hiddenInset',
    show: false,
    backgroundColor,
  })
  // maximize() would show the window before its page loads; both wait for the first show.
  win.once('show', () => {
    if (saved?.maximized) win.maximize()
    if (saved?.fullScreen) win.setFullScreen(true)
  })

  const shell = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  shell.setBackgroundColor(backgroundColor)
  win.contentView.addChildView(shell)
  const fit = (): void => {
    const b = win.getContentBounds()
    shell.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
  }
  fit()
  win.on('resize', fit)

  shell.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  shell.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })

  const dev = process.env.ELECTRON_RENDERER_URL
  // Test launches run while Isaac works on this Mac, including specs that exercise the real
  // (non-e2e) show path. The window must exist and paint (CDP screenshots and capturePage read
  // the compositor, not the screen), but it stays invisible, click-through and never active.
  if (env.hiddenWindow) {
    win.setOpacity(0)
    win.setIgnoreMouseEvents(true)
  }
  const show = (): void => {
    if (env.hiddenWindow) win.showInactive()
    else win.show()
  }
  // Never leave an invisible process: a failed load shows the window and an error, and a
  // fallback timer shows it even if neither load event arrives.
  const reportLoadFailure = (detail: string): void => {
    if (!win.isDestroyed()) show()
    dialog.showErrorBox(APP_NAME, `The interface failed to load.\n\n${detail}`)
  }
  shell.webContents.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 is ERR_ABORTED (a superseded navigation)
    reportLoadFailure(`${description} (${code})`)
  })
  const load = dev
    ? shell.webContents.loadURL(dev)
    : shell.webContents.loadFile(path.join(rendererDir, 'index.html'))
  load.catch(() => {
    // did-fail-load already reported it; nothing else to do.
  })

  if (env.e2e) win.showInactive()
  else {
    const fallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) show()
    }, 10_000)
    shell.webContents.once('did-finish-load', () => {
      clearTimeout(fallback)
      show()
    })
  }

  return { win, shell }
}
