import { contextBridge, ipcRenderer } from 'electron'
import { createEvaBridge, type IpcLike } from './bridge'

contextBridge.exposeInMainWorld('eva', createEvaBridge(ipcRenderer as unknown as IpcLike))
