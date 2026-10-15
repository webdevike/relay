import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'
import { contextBridge, ipcRenderer } from 'electron'
import { createEvaBridge, type IpcLike } from './bridge'

contextBridge.exposeInMainWorld('eva', createEvaBridge(ipcRenderer as unknown as IpcLike))

// Defines <browser-action-list> in the shell page (T-01-47: nothing else is added to the bridge).
injectBrowserAction()
