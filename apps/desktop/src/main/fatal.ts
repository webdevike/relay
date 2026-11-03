import { dialog } from 'electron'

/**
 * Shows a fatal error. Hidden test instances (EVAOS_HIDDEN_WINDOW=1) print it to stderr instead:
 * they never put anything on Isaac's screen.
 */
export function reportFatal(hidden: boolean, title: string, message: string): void {
  if (hidden) {
    process.stderr.write(`${title}: ${message}\n`)
    return
  }
  dialog.showErrorBox(title, message)
}
