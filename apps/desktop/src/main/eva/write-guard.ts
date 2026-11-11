import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installWriteTrap, realpathLoose } from '@evaos/eva-core'
import type { Env } from '../env'
import { registerTestHook } from '../test-hooks'

const real = (p: string): string => realpathLoose(path.resolve(p))

/**
 * Runtime half of the Eva write protection: any node:fs write under the Eva checkout that does
 * not go through EvaFs throws. The repo, the config dir, tmp and the room workdirs
 * (`<eva>/work/rooms`, gitignored scratch a council room owns: its saved state, seat scratch and
 * guard files) stay writable.
 */
export function installWriteGuard(env: Env): void {
  const evaRoots = [env.evaRoot, path.join(os.homedir(), 'Eva')]
  const protectedRoots = [...new Set(evaRoots.filter((p) => fs.existsSync(p)).map(real))]
  const hits: string[] = []
  installWriteTrap({
    protectedRoots,
    allowRoots: [
      ...new Set(
        [
          env.repoRoot,
          env.configDir,
          os.tmpdir(),
          ...evaRoots.map((r) => path.join(r, 'work', 'rooms')),
        ].map(real),
      ),
    ],
    onBlock: (p) => hits.push(p),
  })
  registerTestHook('writeTrapHits', hits)
}
