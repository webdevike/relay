#!/usr/bin/env node
// Turns a raw record-omp.mjs log into scrubbed fixtures/fake-omp/recordings/{turn,abort-tail,long-turn}.jsonl
// Usage: node scripts/scrub-recording.mjs <raw.jsonl>
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'fake-omp',
  'recordings',
)
const raw = readFileSync(process.argv[2], 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
const frames = raw.map((r) => ({ t: r.t, frame: JSON.parse(r.line) }))

const scrubStr = (s) =>
  s
    .replace(/\/(?:Users|var|private|home)\/[^"\s\\]*/g, '/fixture/path')
    .replace(/\bike\b|iweber/gi, 'user')
const scrub = (v) => {
  if (typeof v === 'string') return scrubStr(v)
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === 'timestamp') o[k] = 1700000000000
      else if (k === 'responseId' || k === 'id') o[k] = typeof x === 'string' ? 'fixture-id' : x
      else o[k] = scrub(x)
    }
    return o
  }
  return v
}
const firstIdx = (type, from = 0) => frames.findIndex((f, i) => i >= from && f.frame.type === type)
const a1 = firstIdx('agent_start')
const s1 = firstIdx('session_settled')
const a2 = firstIdx('agent_start', s1 + 1)
const s2 = firstIdx('session_settled', a2)
const turn = frames.slice(a1, s1 + 1)
// abort tail: from the aborted assistant message_end onward, ending at session_settled
const endIdx = frames.findIndex(
  (f, i) => i > a2 && f.frame.type === 'message_end' && f.frame.message?.role === 'assistant',
)
const tail = frames.slice(endIdx, s2 + 1)

const withDt = (arr) =>
  arr.map((f, i) => ({ dt: i === 0 ? 0 : Math.max(0, f.t - arr[i - 1].t), frame: scrub(f.frame) }))
const write = (name, arr) =>
  writeFileSync(join(dir, name), arr.map((x) => JSON.stringify(x)).join('\n') + '\n')
write('turn.jsonl', withDt(turn))
write('abort-tail.jsonl', withDt(tail))

// long-turn: extend assistant text to ~400 message_update frames by repeating text deltas.
const t = withDt(turn)
const upd = t.filter((x) => x.frame.type === 'message_update')
const startIdx = t.findIndex(
  (x) => x.frame.type === 'message_start' && x.frame.message.role === 'assistant',
)
const endMsgIdx = t.findIndex(
  (x) => x.frame.type === 'message_end' && x.frame.message.role === 'assistant',
)
const base = t[endMsgIdx].frame.message
const words = 'Foxes hunt at dusk and cache food. '.split(' ')
let text = ''
const longUpdates = []
for (let i = 0; i < 400; i++) {
  const delta = words[i % words.length] + ' '
  text += delta
  const msg = { ...base, content: [{ type: 'text', text }], stopReason: undefined }
  delete msg.stopReason
  longUpdates.push({
    dt: 15,
    frame: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
      message: msg,
      messageId: 'msg-2',
    },
  })
}
const finalMsg = { ...base, content: [{ type: 'text', text }] }
const lt = [
  ...t.slice(0, startIdx + 1),
  ...longUpdates,
  { dt: 15, frame: { ...t[endMsgIdx].frame, message: finalMsg } },
  ...t
    .slice(endMsgIdx + 1)
    .map((x) =>
      x.frame.type === 'turn_end' ? { ...x, frame: { ...x.frame, message: finalMsg } } : x,
    ),
]
write('long-turn.jsonl', lt)
console.log({ turn: turn.length, tail: tail.length, long: lt.length, updates: upd.length })
