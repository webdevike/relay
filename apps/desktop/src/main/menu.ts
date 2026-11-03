import { Menu, type MenuItemConstructorOptions } from 'electron'

/** App menu with no `close` role or Cmd+W accelerator: Cmd+W closes a browser tab instead. */
export function installAppMenu(name: string): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
