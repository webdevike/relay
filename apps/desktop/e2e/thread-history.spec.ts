import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, expect } from './fixtures'

// An assistant's thread after a rollover or restart: the host keeps the earlier contexts in
// `<relay>/assistants/<id>.json` and the chat on the live session shows them above it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-thread-history-'))
const sessions = path.join(root, 'sessions')
const relay = path.join(root, 'relay')
fs.mkdirSync(sessions)
fs.mkdirSync(path.join(relay, 'assistants'), { recursive: true })

const j = (o: unknown): string => JSON.stringify(o)
function session(name: string, turns: Array<[string, string]>): string {
  const file = path.join(sessions, `2026-11-16T00-00-00-000Z_${name}.jsonl`)
  const lines = [j({ type: 'session', id: name, cwd: '/x' })]
  let parent: string | null = null
  turns.forEach(([asked, said], i) => {
    const u = `${name}-u${String(i)}`
    const a = `${name}-a${String(i)}`
    lines.push(
      j({ type: 'message', id: u, parentId: parent, message: { role: 'user', content: asked } }),
      j({
        type: 'message',
        id: a,
        parentId: u,
        message: { role: 'assistant', content: [{ type: 'text', text: said }] },
      }),
    )
    parent = a
  })
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

const monday = session('monday', [['Book the dentist', 'Booked for Tuesday at five.']])
const today = session('today', [['Order the tiles', 'Ordered the grey tiles.']])
const live = session('live', [['Are you there?', 'Fresh context, still here.']])
fs.writeFileSync(
  path.join(relay, 'assistants', 'nova.json'),
  j({ history: [monday, today], sessionFile: live }),
)

test.use({ launchEnv: { EVAOS_SESSIONS_DIR: sessions, EVAOS_RELAY_DIR: relay } })
test.afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

type Hooks = { __evaosShell: { openPlace(page: string, newTab?: boolean, extra?: object): void } }

test('a thread on its live session shows the earlier contexts above it', async ({ shell }) => {
  await shell.evaluate(
    (f) => (window as unknown as Hooks).__evaosShell.openPlace('chat', false, { chat: f }),
    live,
  )
  const log = shell.locator('[data-testid=chat-log]')
  await expect(log).toContainText('Fresh context, still here.')
  await expect(log).toContainText('Ordered the grey tiles.')
  await expect(log).toContainText('Booked for Tuesday at five.')
  const text = (await log.textContent()) ?? ''
  expect(text.indexOf('Booked for Tuesday')).toBeLessThan(text.indexOf('Ordered the grey tiles'))
  expect(text.indexOf('Ordered the grey tiles')).toBeLessThan(text.indexOf('Fresh context'))

  // An earlier context opened on its own is just its file.
  await shell.evaluate(
    (f) => (window as unknown as Hooks).__evaosShell.openPlace('chat', false, { chat: f }),
    today,
  )
  await expect(log).toContainText('Ordered the grey tiles.')
  await expect(log).not.toContainText('Booked for Tuesday at five.')
})
