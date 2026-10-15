import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeChatFixture, writeChatPrefs } from './chat-fixture'
import { AGENT_P4_TEMPLATE } from './paths'

function hashTree(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n)
      const st = fs.statSync(p)
      h.update(path.relative(dir, p))
      if (st.isDirectory()) walk(p)
      else h.update(fs.readFileSync(p)).update(String(st.mtimeMs))
    }
  }
  walk(dir)
  return h.digest('hex')
}

describe('chat fixture', () => {
  it('copies to tmp with deterministic old mtimes and wires launchEnv', () => {
    const fx = makeChatFixture()
    try {
      expect(fx.root.startsWith(os.tmpdir())).toBe(true)
      expect(fx.launchEnv).toEqual({
        EVAOS_AGENT_DIR: fx.agentDir,
        EVAOS_SESSIONS_DIR: fx.sessionsDir,
        FAKE_OMP_SESSIONS_DIR: fx.sessionsDir,
      })
      const files = fs.readdirSync(fx.sessionsDir).filter((n) => n.endsWith('.jsonl'))
      expect(files.length).toBeGreaterThanOrEqual(17)
      for (const n of files) expect(Date.now() - fs.statSync(path.join(fx.sessionsDir, n)).mtimeMs).toBeGreaterThan(3600_000)
      expect(fs.statSync(fx.file('p4-ecard')).mtimeMs).toBeGreaterThan(fs.statSync(fx.file('p4-relay')).mtimeMs)
      expect(JSON.parse(fs.readFileSync(path.join(fx.agentDir, 'session-pins.json'), 'utf8'))).toEqual(['p4-pinned'])
    } finally {
      fx.cleanup()
    }
  })

  it('touch, append and cleanup work and the repo fixture stays byte-identical', async () => {
    const before = hashTree(AGENT_P4_TEMPLATE)
    const fx = makeChatFixture()
    fx.touch('p4-writer', 0)
    expect(Date.now() - fs.statSync(fx.file('p4-writer')).mtimeMs).toBeLessThan(5000)
    const t0 = Date.now()
    await fx.append('p4-writer', '{"type":"x"}', { holdOpen: true })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400)
    expect(fs.readFileSync(fx.file('p4-writer'), 'utf8').endsWith('{"type":"x"}\n')).toBe(true)
    fx.cleanup()
    expect(fs.existsSync(fx.root)).toBe(false)
    expect(hashTree(AGENT_P4_TEMPLATE)).toBe(before)
  })

  it('writeChatPrefs writes pretty chat.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-prefs-'))
    writeChatPrefs(dir, { archived_chats: ['p4-archived'] })
    expect(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8')).toBe('{\n  "archived_chats": [\n    "p4-archived"\n  ]\n}\n')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
