import * as fs from 'node:fs'
import * as path from 'node:path'

/** Temp file in the same directory, then rename. Mirrors the Rust `jobs.rs::write_atomic`. */
export async function atomicWrite(abs: string, data: string | Buffer): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`)
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  try {
    await fs.promises.writeFile(tmp, data)
    await fs.promises.rename(tmp, abs)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true })
    throw err
  }
}
