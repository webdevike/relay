import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Temp file in the same directory, then rename. Mirrors the Rust `jobs.rs::write_atomic`.
 * `commit` runs once the temp file is staged; with it the rename is synchronous right after, so
 * nothing (a Take over, say) runs between the check and the file changing. It throws to write
 * nothing.
 */
export async function atomicWrite(
  abs: string,
  data: string | Buffer,
  commit?: () => void,
): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`)
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  try {
    await fs.promises.writeFile(tmp, data)
    if (commit) {
      commit()
      fs.renameSync(tmp, abs)
    } else await fs.promises.rename(tmp, abs)
  } catch (err) {
    await fs.promises.rm(tmp, { force: true })
    throw err
  }
}
