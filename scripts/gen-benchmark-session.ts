// Deterministic generator for the synthetic 5,000-message benchmark omp session (format v3).
// Run: node scripts/gen-benchmark-session.ts
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const COUNT = 5000
const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(
  here,
  '../fixtures/agent/sessions/-fixture/2026-10-02T09-00-00-000Z_bench5000.jsonl',
)

let state = 42
const rand = (): number => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0
  return state / 0x100000000
}
const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))

const WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliet',
  'kilo',
  'lima',
]
const sentence = (): string =>
  Array.from({ length: int(4, 14) }, () => WORDS[int(0, WORDS.length - 1)]).join(' ')
const lines = (n: number): string => Array.from({ length: n }, sentence).join('\n')

const BASE = Date.parse('2026-10-02T09:00:00.000Z')
const ts = (i: number): string => new Date(BASE + i * 1000).toISOString()
const rows: unknown[] = []
rows.push({ type: 'title', v: 1, title: 'Benchmark 5000', updatedAt: BASE, pad: '    ' })
rows.push({
  type: 'session',
  version: 3,
  id: 'bench5000',
  timestamp: ts(0),
  cwd: '/fixture/eva-root',
})

let parent: string | null = null
let seq = 0
const push = (rec: Record<string, unknown>): string => {
  const id = `r${String(seq++).padStart(5, '0')}`
  rows.push({ id, parentId: parent, timestamp: ts(seq), ...rec })
  parent = id
  return id
}

push({ type: 'model_change', model: 'anthropic/claude-opus-5-5' })
push({ type: 'thinking_level_change', thinkingLevel: 'medium' })

for (let n = 1; n <= COUNT; n++) {
  if (n % 1000 === 0) push({ type: 'custom', customType: 'todo_hud_state', data: { n } })
  if (n % 2 === 1) {
    push({
      type: 'message',
      message: { role: 'user', content: `Request ${n}: ${sentence()}`, attribution: 'user' },
    })
    continue
  }
  const content: unknown[] = []
  if (n % 11 === 0)
    content.push({ type: 'thinking', thinking: `Thinking about ${n}: ${sentence()}` })
  let text = `Reply ${n}\n${lines(int(1, 40))}`
  if (n % 7 === 0) text += `\n\`\`\`ts\nconst value${n} = ${n}\nconsole.log(value${n})\n\`\`\``
  if (n % 97 === 0) text += '\nLaunch \u{1F680}'
  if (n === COUNT) text += '\nLAST-MESSAGE-MARKER'
  content.push({ type: 'text', text })
  const callId = `call${n}`
  const withTool = n % 13 === 0
  if (withTool)
    content.push({
      type: 'toolCall',
      id: callId,
      name: 'read',
      arguments: { i: `Reading file ${n}`, path: `notes/${n}.md` },
    })
  push({
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      content,
      usage: { input: 1000 + n, cacheRead: 500, cacheWrite: 0 },
      stopReason: withTool ? 'toolUse' : 'stop',
    },
  })
  if (withTool) {
    push({
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: callId,
        toolName: 'read',
        content: [{ type: 'text', text: `contents of ${n}\n${sentence()}` }],
        isError: false,
      },
    })
  }
}

fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`wrote ${rows.length} records to ${out}`)
