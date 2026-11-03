import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installWriteTrap, realpathLoose } from '@evaos/eva-core'
import type { Env } from '../env'
import { registerTestHook } from '../test-hooks'

const real = (p: string): string => realpathLoose(path.resolve(p))

/**
 * Runtime half of the Eva write protection: any node:fs write under the Eva checkout that does
 * not go through EvaFs throws. The repo, the config dir and tmp stay writable.
 */
export function installWriteGuard(env: Env): void {
  const protectedRoots = [
    ...new Set(
      [env.evaRoot, path.join(os.homedir(), 'Eva')].filter((p) => fs.existsSync(p)).map(real),
    ),
  ]
  const hits: string[] = []
  installWriteTrap({
    protectedRoots,
    allowRoots: [...new Set([env.repoRoot, env.configDir, os.tmpdir()].map(real))],
    onBlock: (p) => hits.push(p),
  })
  registerTestHook('writeTrapHits', hits)
}
