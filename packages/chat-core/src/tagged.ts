import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'

export { untagged } from './session'

export interface MachineLabelDeps {
  home: string
  readFile: (file: string) => string | null
  hostname: () => string
}

const defaultDeps = (): MachineLabelDeps => ({
  home: os.homedir(),
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  hostname: () => os.hostname(),
})

/** This box's line in `~/.config/eva/machine`, else its short hostname, else `Mac` (Rust `machine_label`). */
export function machineLabel(deps: MachineLabelDeps = defaultDeps()): string {
  const configured = deps.readFile(path.join(deps.home, '.config/eva/machine'))?.trim()
  if (configured) return configured
  const host = deps.hostname().trim().split('.')[0]
  return host ? host : 'Mac'
}

/** The client half of the surface tag: where Isaac typed, after the machine label. */
export const DESKTOP_CLIENT = 'Relay Desktop'

/**
 * `text` with the surface tag on its own first line, `<surface>Mac Mini - Relay Desktop 31e5563 ·
 * host 0.2.51</surface>`, so the agent knows where Isaac is typing and which build he runs.
 * `detail` is what follows the client name (build and host version, `surfaceDetail`); a hook
 * reads the tool as the words after ` - ` up to the build. Slash commands and blank text go untagged.
 */
export function tagged(text: string, label: string, detail = ''): string {
  if (text.trimStart().startsWith('/') || text.trim() === '') return text
  return `<surface>${label} - ${DESKTOP_CLIENT}${detail}</surface>\n${text}`
}
