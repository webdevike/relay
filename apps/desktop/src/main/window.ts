import { BaseWindow, WebContentsView, dialog } from 'electron'
import * as path from 'node:path'
import type { Env } from './env'
import { isAppUrl } from './app-url'

export { isAppUrl }

const rendererDir = path.join(__dirname, '../renderer')

export function createMainWindow(
  env: Env,
  backgroundColor = '#181817',
): { win: BaseWindow; shell: WebContentsView } {
  const win = new BaseWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 720,
    titleBarStyle: 'hiddenInset',
    show: false,
    backgroundColor,
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
  // Never leave an invisible process: a failed load shows the window and an error, and a
  // fallback timer shows it even if neither load event arrives.
  const reportLoadFailure = (detail: string): void => {
    if (!win.isDestroyed()) win.show()
    dialog.showErrorBox('EvaOS', `The interface failed to load.\n\n${detail}`)
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

  if (env.e2e) {
    // Tests run while Isaac works on this Mac. The window must exist and paint (CDP screenshots
    // and capturePage read the compositor, not the screen), but it stays invisible and lets every
    // click through, so it never covers his windows.
    win.setOpacity(0)
    win.setIgnoreMouseEvents(true)
    win.showInactive()
  } else {
    const fallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show()
    }, 10_000)
    shell.webContents.once('did-finish-load', () => {
      clearTimeout(fallback)
      win.show()
    })
  }

  return { win, shell }
}
