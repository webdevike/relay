// postinstall: node-pty 1.1.0 ships its prebuilt `spawn-helper` without the execute bit and has no
// script that sets it, so on a fresh install every pty.spawn fails with "posix_spawnp failed." (the
// Terminal tab never starts a shell). Set the bit on every installed copy.
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'

let root
try {
  root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
} catch {
  process.exit(0)
}
const prebuilds = join(root, 'prebuilds')
if (existsSync(prebuilds)) {
  for (const arch of readdirSync(prebuilds)) {
    const helper = join(prebuilds, arch, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
