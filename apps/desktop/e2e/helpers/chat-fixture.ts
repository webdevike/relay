// A disposable copy of fixtures/agent-p4 with deterministic mtimes, for destructive chat specs.
// The repo fixture is never modified: everything happens in a tmp copy that cleanup() removes.
//
//   let fx: ChatFixture
//   test.beforeEach(() => { fx = makeChatFixture() })
//   test.afterEach(() => fx.cleanup())
//   launch with { ...fx.launchEnv }
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AGENT_P4_TEMPLATE } from './paths'

export interface ChatFixture {
  root: string
  agentDir: string
  sessionsDir: string
  launchEnv: Record<string, string>
  file(id: string): string
  touch(id: string, msAgo: number): void
  append(id: string, line: string, opts?: { holdOpen?: boolean }): Promise<void>
  cleanup(): void
}

const HOLD_MS = 1500

function findIn(dir: string, id: string): string {
  const name = fs.readdirSync(dir).find((n) => n.endsWith(`_${id}.jsonl`))
  if (!name) throw new Error(`chat fixture: no session ${id} in ${dir}`)
  return path.join(dir, name)
}

export function makeChatFixture(): ChatFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-chat-fx-'))
  const agentDir = path.join(root, 'agent')
  fs.cpSync(AGENT_P4_TEMPLATE, agentDir, { recursive: true })
  const sessionsDir = path.join(agentDir, 'sessions', '-fixture')
  const file = (id: string): string => findIn(sessionsDir, id)

  const manifest = JSON.parse(
    fs.readFileSync(path.join(agentDir, 'mtimes.json'), 'utf8'),
  ) as Record<string, number>
  const now = Date.now()
  for (const [key, minutes] of Object.entries(manifest)) {
    const [id, sub] = key.split('/')
    const target = sub
      ? path.join(path.dirname(file(id)), path.basename(file(id), '.jsonl'), `${sub}.jsonl`)
      : file(id)
    const when = new Date(now - minutes * 60_000)
    fs.utimesSync(target, when, when)
  }

  return {
    root,
    agentDir,
    sessionsDir,
    launchEnv: {
      EVAOS_AGENT_DIR: agentDir,
      EVAOS_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
    },
    file,
    touch(id, msAgo) {
      const when = new Date(Date.now() - msAgo)
      fs.utimesSync(file(id), when, when)
    },
    async append(id, line, opts) {
      const fd = fs.openSync(file(id), 'a')
      try {
        fs.writeSync(fd, line.endsWith('\n') ? line : line + '\n')
        if (opts?.holdOpen) await new Promise((r) => setTimeout(r, HOLD_MS))
      } finally {
        fs.closeSync(fd)
      }
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Writes `<configDir>/chat.json` (pretty JSON) before the app launches. */
export function writeChatPrefs(configDir: string, prefs: Record<string, unknown>): void {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'chat.json'), JSON.stringify(prefs, null, 2) + '\n')
}
