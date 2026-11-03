import * as fs from 'node:fs'

/** The desktop app's name: the menu, dialogs and the packaged bundle (electron-builder.yml). */
export const APP_NAME = 'Relay'
/** Every copy that is not the stable app: agent tests, `pnpm dev`, `pnpm dev:live`, e2e. */
export const DEV_APP_NAME = 'Relay Dev'

export function appName(instance: 'stable' | 'dev'): string {
  return instance === 'stable' ? APP_NAME : DEV_APP_NAME
}

/**
 * Moves the pre-rename config folder into place once, so a renamed install keeps its chats,
 * layout and browser profile. Does nothing when there is no legacy folder or the new one exists.
 */
export function moveLegacyConfig(legacyDir: string | null, configDir: string): void {
  if (!legacyDir || fs.existsSync(configDir) || !fs.existsSync(legacyDir)) return
  fs.renameSync(legacyDir, configDir)
}
