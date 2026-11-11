import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJevKey } from './jev'

const KEY = 'test-key-not-real'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('readJevKey', () => {
  it('prefers the environment, then secrets/jev.env, else null', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-'))
    dirs.push(root)
    expect(readJevKey(root, {})).toBeNull()
    expect(readJevKey(root, { TYPESAFE_API_KEY: ` ${KEY} ` })).toBe(KEY)
    fs.mkdirSync(path.join(root, 'secrets'))
    fs.writeFileSync(
      path.join(root, 'secrets/jev.env'),
      `# jev\nTYPESAFE_API_KEY=${KEY}\nOTHER=1\n`,
    )
    expect(readJevKey(root, {})).toBe(KEY)
    fs.writeFileSync(path.join(root, 'secrets/jev.env'), 'OTHER=1\n')
    expect(readJevKey(root, {})).toBeNull()
  })
})
