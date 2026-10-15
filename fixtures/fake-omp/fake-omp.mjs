#!/usr/bin/env node
// Deterministic omp stand-in for `--mode rpc-ui` (D-23). No dependencies. See README.md.
// Never opens the --resume file for writing; exits 0 when stdin closes; logs signals instead of hiding them.
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const mode = arg('--mode')
const resumeFile = arg('--resume') ?? null
const CHUNK = process.env.FAKE_OMP_CHUNK ?? 'line'
const DELAY = CHUNK === 'burst' ? 0 : CHUNK === 'slow' ? 150 : Number(process.env.FAKE_OMP_DELAY_MS ?? 15)
const RECORDING = process.env.FAKE_OMP_RECORDING ?? 'turn'
const LOG = process.env.FAKE_OMP_LOG
const STDERR = process.env.FAKE_OMP_STDERR === '1'

const log = (event, detail) => {
  if (!LOG) return
  try {
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), event, detail }) + '\n')
  } catch {
    /* ignore */
  }
}
log('spawn', { argv, resumeFile, chunk: CHUNK })

if (mode !== 'rpc-ui') {
  process.stderr.write(`fake-omp: unsupported mode ${mode}\n`)
  process.exit(2)
}

const load = (name) =>
  readFileSync(join(here, 'recordings', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).frame)
const turnFrames = load(RECORDING)
const abortTail = load('abort-tail')
const recordedPrompt = turnFrames.find((f) => f.type === 'message_start' && f.message?.role === 'user')?.message.content[0].text

// ---- output writer: ordered, with hostile chunking
let chain = Promise.resolve()
const rawWrite = (buf) => new Promise((res) => process.stdout.write(buf, () => res()))
const later = () => new Promise((res) => setImmediate(res))
const writeLines = (lines) => {
  chain = chain.then(async () => {
    if (CHUNK === 'glued') return rawWrite(Buffer.from(lines.join('')))
    for (const line of lines) {
      const buf = Buffer.from(line)
      if (CHUNK === '1') {
        for (let i = 0; i < buf.length; i++) {
          await rawWrite(buf.subarray(i, i + 1))
          await later()
        }
      } else if (CHUNK === 'emoji-split') {
        const at = buf.findIndex((b) => b >= 0x80)
        if (at >= 0 && at + 1 < buf.length) {
          await rawWrite(buf.subarray(0, at + 1))
          await later()
          await rawWrite(buf.subarray(at + 1))
        } else await rawWrite(buf)
      } else await rawWrite(buf)
    }
  })
  return chain
}
const emit = (frame) => writeLines([JSON.stringify(frame) + '\n'])
const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// ---- session state
let msgCounter = 0
let replay = null // { id, aborted, promptId, curAssistantId }
let steers = [] // { id, text }
let messageCount = 0

const nextMsgId = () => `msg-${++msgCounter}`

const rewrite = (frame, ctx) => {
  let s = JSON.stringify(frame)
  if (recordedPrompt && ctx.text !== recordedPrompt) s = s.split(JSON.stringify(recordedPrompt).slice(1, -1)).join(JSON.stringify(ctx.text).slice(1, -1))
  const f = JSON.parse(s)
  if (f.type === 'message_start' && f.message?.role) {
    ctx.cur = nextMsgId()
    if (f.message.role === 'assistant') ctx.assistant = ctx.cur
    messageCount++
  }
  if ('messageId' in f && ctx.cur) f.messageId = f.type.startsWith('message_') && f.message?.role === 'assistant' ? (ctx.assistant ?? ctx.cur) : ctx.cur
  if (f.type === 'prompt_result') f.id = ctx.promptId
  if (f.type === 'response' && f.command === 'abort') f.id = ctx.abortId
  return f
}

async function playFrames(frames, ctx, glue) {
  const lines = []
  for (const raw of frames) {
    if (ctx.aborted) return false
    const f = rewrite(raw, ctx)
    if (glue) lines.push(JSON.stringify(f) + '\n')
    else {
      await emit(f)
      if (DELAY) await sleep(DELAY)
    }
  }
  if (glue) await writeLines(lines)
  return true
}

function shortReply(text) {
  const base = { api: 'anthropic-messages', provider: 'anthropic', model: 'fake-omp', usage: { input: 1, output: 1 } }
  const parts = ['Steer ', 'received: ', text]
  const out = [{ type: 'agent_start' }, { type: 'turn_start' }]
  out.push({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user', timestamp: 1700000000000 }, messageId: 'x' })
  out.push({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user', timestamp: 1700000000000 }, messageId: 'x' })
  let acc = ''
  out.push({ type: 'message_start', message: { ...base, role: 'assistant', content: [{ type: 'text', text: '' }] }, messageId: 'x' })
  for (const p of parts) {
    acc += p
    out.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: p }, message: { ...base, role: 'assistant', content: [{ type: 'text', text: acc }] }, messageId: 'x' })
  }
  const fin = { ...base, role: 'assistant', content: [{ type: 'text', text: acc }], stopReason: 'stop' }
  out.push({ type: 'message_end', message: fin, messageId: 'x' })
  out.push({ type: 'turn_end', message: fin, toolResults: [] })
  out.push({ type: 'agent_end', messages: [fin], messageCount: 2 })
  out.push({ type: 'prompt_result', id: 'x', agentInvoked: true, status: 'completed', sessionSettled: true })
  out.push({ type: 'session_settled' })
  return out
}

async function runReplay(promptId, text) {
  const ctx = { promptId, text, aborted: false, cur: null, assistant: null }
  replay = ctx
  if (STDERR) process.stderr.write(`fake-omp: handling prompt ${promptId}\n`)
  await playFrames(turnFrames, ctx, CHUNK === 'glued')
  if (ctx.aborted) return
  replay = null
  // steers are delivered at the turn boundary, after the current replay ends
  while (steers.length && !ctx.aborted) {
    const s = steers.shift()
    await emit({ type: 'queue_update', steering: steers.map((x) => x.text), followUp: [] })
    const c2 = { promptId: s.id, text: s.text, aborted: false, cur: null, assistant: null }
    replay = c2
    await playFrames(shortReply(s.text), c2, CHUNK === 'glued')
    if (c2.aborted) return
    replay = null
  }
}

const respond = (id, command, extra = {}) => emit({ ...(id ? { id } : {}), type: 'response', command, success: true, ...extra })

async function handle(cmd) {
  const { type, id } = cmd
  switch (type) {
    case 'set_ask_dialog':
      return respond(id, type, { data: { enabled: cmd.enabled !== false } })
    case 'set_subagent_subscription':
      return respond(id, type, { data: { level: cmd.level ?? 'off' } })
    case 'get_state':
      return respond(id, type, {
        data: {
          sessionFile: resumeFile,
          sessionId: 'fake-session',
          isStreaming: replay !== null,
          isSettled: replay === null,
          messageCount,
          model: { id: 'fake-omp', provider: 'fake' },
          thinkingLevel: 'off',
        },
      })
    case 'prompt': {
      await respond(id, type)
      const text = String(cmd.message ?? '')
      if (replay) {
        steers.push({ id, text })
        return emit({ type: 'queue_update', steering: steers.map((s) => s.text), followUp: [] })
      }
      // do not await: stdin must keep being served while replaying
      void runReplay(id, text)
      return
    }
    case 'abort': {
      if (!replay) return respond(id, type)
      const ctx = replay
      ctx.aborted = true
      replay = null
      steers = []
      const t = { promptId: ctx.promptId, text: ctx.text, aborted: false, cur: ctx.assistant, assistant: ctx.assistant, abortId: id }
      // tail's first frame is the aborted assistant message_end: keep the live assistant id
      await playFrames(abortTail, t, false)
      return
    }
    case 'extension_ui_response':
      return
    default:
      return emit({ ...(id ? { id } : {}), type: 'response', command: type, success: false, error: `Unknown command: ${type}` })
  }
}

// ---- stdin: own \n splitter
let carry = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  carry += d
  let i
  while ((i = carry.indexOf('\n')) >= 0) {
    const line = carry.slice(0, i).replace(/\r$/, '')
    carry = carry.slice(i + 1)
    if (!line.trim()) continue
    let cmd
    try {
      cmd = JSON.parse(line)
    } catch {
      log('stdin-line', { bad: line.slice(0, 200) })
      continue
    }
    log('stdin-line', { type: cmd.type, id: cmd.id })
    void handle(cmd)
  }
})
process.stdin.on('end', async () => {
  log('stdin-end', null)
  if (replay) replay.aborted = true
  await chain
  setTimeout(() => {
    log('exit', { code: 0 })
    process.exit(0)
  }, 200)
})
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(sig, () => {
    log('signal', sig)
    process.exit(128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGHUP' ? 1 : 2))
  })
}

void emit({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 })
