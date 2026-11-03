import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ConfigStore {
  readonly dir: string
  readJson<T>(name: string, fallback: T): T
  /** File text, or null only when the file does not exist. */
  readText(name: string): string | null
  /** `mode` (e.g. 0o600 for a secret) applies to the written file; default is the umask's. */
  writeJson(name: string, value: unknown, mode?: number): void
  /**
   * Existing object to merge into before a write. Missing file gives {}. Unreadable (EACCES, EIO)
   * throws so the writer aborts. Unparseable or non-object content is copied to `<name>.bad`
   * first, so a merge-write never silently destroys it.
   */
  readForMerge(name: string): Record<string, unknown>
}

function checkName(name: string): void {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`Invalid config file name: ${name}`)
  }
}

/**
 * The app's own state lives only under configDir. This is the one reviewed writer that is not
 * EvaFs: it never touches the Eva checkout.
 */
export function createConfigStore(configDir: string): ConfigStore {
  fs.mkdirSync(configDir, { recursive: true })
  return {
    dir: configDir,
    readJson<T>(name: string, fallback: T): T {
      checkName(name)
      try {
        return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8')) as T
      } catch {
        return fallback
      }
    },
    readText(name: string): string | null {
      checkName(name)
      try {
        return fs.readFileSync(path.join(configDir, name), 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    readForMerge(name: string): Record<string, unknown> {
      checkName(name)
      const file = path.join(configDir, name)
      const text = this.readText(name)
      if (text === null) return {}
      try {
        const v: unknown = JSON.parse(text)
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          return v as Record<string, unknown>
        }
      } catch {
        // fall through to the backup
      }
      fs.writeFileSync(`${file}.bad`, text)
      return {}
    },
    writeJson(name: string, value: unknown, mode?: number): void {
      checkName(name)
      const tmp = path.join(configDir, `.${name}.${process.pid}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
      if (mode !== undefined) fs.chmodSync(tmp, mode)
      fs.renameSync(tmp, path.join(configDir, name))
    },
  }
}
