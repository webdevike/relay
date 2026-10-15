import { BaseWindow, WebContentsView } from 'electron'
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
  if (dev) void shell.webContents.loadURL(dev)
  else void shell.webContents.loadFile(path.join(rendererDir, 'index.html'))

  if (env.e2e) win.showInactive()
  else shell.webContents.once('did-finish-load', () => win.show())

  return { win, shell }
}
