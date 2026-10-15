import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ConfigStore {
  readonly dir: string
  readJson<T>(name: string, fallback: T): T
  /** File text, or null only when the file does not exist. */
  readText(name: string): string | null
  writeJson(name: string, value: unknown): void
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
    writeJson(name: string, value: unknown): void {
      checkName(name)
      const tmp = path.join(configDir, `.${name}.${process.pid}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
      fs.renameSync(tmp, path.join(configDir, name))
    },
  }
}
