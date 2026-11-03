import * as fs from 'node:fs'
import * as path from 'node:path'

/** Where the running app announces its control API: `<configDir>/agent-control.json`. */
export const CONTROL_FILE = 'agent-control.json'

export interface ControlFile {
  port: number
  token: string
  url: string
  pid: number
  startedAt: string
}

/** Writes the port and token for relay-ctl: owner-only (0600), replaced atomically. */
export function writeControlFile(dir: string, info: { port: number; token: string }): string {
  const file = path.join(dir, CONTROL_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  const body: ControlFile = {
    ...info,
    url: `http://127.0.0.1:${info.port}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  return file
}

/** Removes the control file if this process still owns it (a newer run may have replaced it). */
export function removeControlFile(file: string): void {
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number }
    if (cur.pid === process.pid) fs.unlinkSync(file)
  } catch {
    // Already gone.
  }
}
