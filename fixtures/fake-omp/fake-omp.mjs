#!/usr/bin/env node
// Deterministic omp stand-in for `--mode rpc-ui` (D-23). No dependencies. See README.md.
// Never opens the --resume file for writing in rpc-ui mode (only the short-lived `--mode rpc` rename does);
// exits 0 when stdin closes; logs signals instead of hiding them.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
// A Relay room member (desktop main/rooms/chat-room.ts): answers as itself, slowly enough to watch.
const roomSeat = /^You are (.+?), a member of a Relay room/.exec(arg('--system-prompt') ?? '')?.[1] ?? null

// ---- `usage --json` (the usage meter): the profile's fixture, timestamps moved to now.
if (mode === undefined && argv.includes('usage')) {
  const profile = arg('--profile') ?? 'default'
  const dir = process.env.FAKE_OMP_USAGE_DIR || join(here, 'usage')
  let text
  try {
    text = readFileSync(join(dir, `${profile}.json`), 'utf8')
  } catch {
    process.stderr.write(`fake-omp: no usage for profile ${profile}\n`)
    process.exit(1)
  }
  let out = text
  try {
    const doc = JSON.parse(text)
    const shift = Date.now() - doc.generatedAt
    const move = (t) => (typeof t === 'number' ? t + shift : t)
    doc.generatedAt = move(doc.generatedAt)
    for (const r of doc.reports ?? []) {
      r.fetchedAt = move(r.fetchedAt)
      for (const l of r.limits ?? []) if (l.window) l.window.resetsAt = move(l.window.resetsAt)
    }
    out = JSON.stringify(doc, null, 2) + '\n'
  } catch {
    /* not JSON: printed as is, for parse-failure tests */
  }
  await new Promise((res) => process.stdout.write(out, res))
  process.exit(0)
}
const CHUNK = process.env.FAKE_OMP_CHUNK ?? 'line'
const DELAY = CHUNK === 'burst' ? 0 : CHUNK === 'slow' ? 150 : Number(process.env.FAKE_OMP_DELAY_MS ?? 15)
const RECORDING = process.env.FAKE_OMP_RECORDING ?? 'turn'
const LOG = process.env.FAKE_OMP_LOG
const STDERR = process.env.FAKE_OMP_STDERR === '1'
const REAL_TIME = process.env.FAKE_OMP_REAL_TIME === '1'

const log = (event, detail) => {
  if (!LOG) return
  try {
    appendFileSync(LOG, JSON.stringify({ t: Date.now(), event, detail }) + '\n')
  } catch {
    /* ignore */
  }
}
log('spawn', { argv, resumeFile, chunk: CHUNK })

const SESSIONS_DIR = process.env.FAKE_OMP_SESSIONS_DIR || null
const RPC_ONLY = mode === 'rpc'

if (mode !== 'rpc-ui' && mode !== 'rpc') {
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
const state = { model: { id: 'fake-omp', provider: 'fake', contextWindow: 200000 }, thinkingLevel: 'off', fastModeEnabled: false, sessionName: null }
const MODELS = [
  { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Opus 5.5', reasoning: true, input: ['text', 'image'], contextWindow: 200000, thinking: { efforts: ['low', 'medium', 'high'] } },
  { provider: 'anthropic', id: 'claude-opus-5-5-20261001', name: 'Opus 5.5 (2026-10-01)', reasoning: true, input: ['text', 'image'], contextWindow: 200000, thinking: { efforts: ['low', 'medium', 'high'] } },
  { provider: 'fake', id: 'text-only', name: 'Text Only', reasoning: false, input: ['text'], contextWindow: 32000 },
  { provider: 'fake', id: 'no-window', name: 'No Window', reasoning: false, input: ['text', 'image'], contextWindow: null },
]
// A chat started without --resume: omp plans the file now and writes it on the first prompt.
const plannedFile = resumeFile
  ? null
  : SESSIONS_DIR
    ? join(SESSIONS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID()}.jsonl`)
    : null
let planCreated = false
const ensureSessionFile = (text) => {
  if (resumeFile || !plannedFile || planCreated) return
  planCreated = true
  mkdirSync(dirname(plannedFile), { recursive: true })
  const header = { type: 'session', version: 3, id: 'fake-session', timestamp: new Date().toISOString(), cwd: process.cwd() }
  const user = { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: text, attribution: 'user' } }
  writeFileSync(plannedFile, JSON.stringify(header) + '\n' + JSON.stringify(user) + '\n')
}
const pending = new Map() // dialog request id -> resolver
let uiCounter = 0

const nextMsgId = () => `msg-${++msgCounter}`

const rewrite = (frame, ctx) => {
  let s = JSON.stringify(frame)
  if (recordedPrompt && ctx.text !== recordedPrompt) s = s.split(JSON.stringify(recordedPrompt).slice(1, -1)).join(JSON.stringify(ctx.text).slice(1, -1))
  // FAKE_OMP_REAL_TIME=1: messages stamped now, as real omp does (recordings carry 2023 stamps), for
  // specs that place rows by time.
  if (REAL_TIME) s = s.replace(/"timestamp":\d{12,}/g, `"timestamp":${Date.now()}`)
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
      const d = ctx.delay ?? DELAY
      if (d) await sleep(d)
    }
  }
  if (glue) await writeLines(lines)
  return true
}

function shortReply(text, opts = {}) {
  const base = { api: 'anthropic-messages', provider: 'anthropic', model: 'fake-omp', usage: { input: 1, output: 1 } }
  const parts = opts.parts ?? ['Steer ', 'received: ', text]
  const out = opts.skipStart ? [{ type: 'turn_start' }] : [{ type: 'agent_start' }, { type: 'turn_start' }]
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
  ensureSessionFile(text)
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

const DIALOG_KEYWORDS = ['[ask-multi]', '[ask-bad]', '[select]', '[confirm]', '[input]', '[editor]', '[ask]']
const dialogFrame = (kw, id) => {
  switch (kw) {
    case '[select]':
      return { method: 'select', title: 'Pick one', options: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'], optionDetails: [{}, { description: 'second option' }, {}, {}, {}] }
    case '[confirm]':
      return { method: 'confirm', title: 'Proceed?', message: 'This is a confirm dialog' }
    case '[input]':
      return { method: 'input', title: 'Your name', placeholder: 'type here' }
    case '[editor]':
      return { method: 'editor', title: 'Edit notes', prefill: 'draft text' }
    case '[ask]':
      return {
        method: 'ask',
        questions: [{ id: 'q1', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'MySQL' }, { label: 'DuckDB' }], recommended: 1 }],
      }
    case '[ask-multi]':
      return {
        method: 'ask',
        questions: [
          { id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }], recommended: 1 },
          { id: 'f', question: 'Features?', options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Export' }], multi: true },
        ],
      }
    default:
      return { method: 'ask', questions: 'not-an-array' }
  }
}

async function runDialog(promptId, text, kw, slow) {
  const ctx = { promptId, text, aborted: false, cur: null, assistant: null, delay: slow ? 400 : undefined }
  replay = ctx
  ensureSessionFile(text)
  await emit({ type: 'agent_start' })
  const reqId = `ui-${++uiCounter}`
  const answer = new Promise((res) => pending.set(reqId, res))
  ctx.pendingId = reqId
  await emit({ type: 'extension_ui_request', id: reqId, ...dialogFrame(kw) })
  const resp = await answer
  pending.delete(reqId)
  if (ctx.aborted) return
  const { type: _t, id: _i, ...rest } = resp
  const body = resp.cancelled ? 'cancelled' : JSON.stringify(rest)
  const reply = `Answer received: ${body}`
  await playFrames(shortReply(text, { parts: [reply], skipStart: true }), ctx, false)
  if (!ctx.aborted) replay = null
}

async function runPlain(promptId, text, images, slow) {
  const ctx = { promptId, text, aborted: false, cur: null, assistant: null, delay: slow ? 400 : undefined }
  replay = ctx
  ensureSessionFile(text)
  const parts = images ? [`Got ${images.length} image(s)`] : ['Slow ', 'reply ', 'for ', 'racing ', 'writers']
  await playFrames(shortReply(text, { parts }), ctx, false)
  if (!ctx.aborted) replay = null
}

let seatTurns = 0
/** `FAKE_OMP_ROOM_SCRIPT`: a JSON file of each member's replies by name, turn by turn (e2e decision cards). */
const roomScript = (() => {
  const file = process.env.FAKE_OMP_ROOM_SCRIPT
  if (!file || !roomSeat) return []
  try {
    return JSON.parse(readFileSync(file, 'utf8'))[roomSeat] ?? []
  } catch {
    return []
  }
})()
async function runSeat(promptId, text, name) {
  const ctx = { promptId, text, aborted: false, cur: null, assistant: null, delay: Number(process.env.FAKE_OMP_SEAT_DELAY_MS ?? 120) }
  replay = ctx
  seatTurns++
  log('seat-turn', { name, turn: seatTurns })
  const scripted = roomScript[seatTurns - 1]
  // A scripted reply streams in six deltas, so markers arrive split across frames as with a model.
  const step = typeof scripted === 'string' ? Math.ceil(scripted.length / 6) : 0
  const parts = typeof scripted === 'string'
    ? Array.from({ length: Math.ceil(scripted.length / step) }, (_, i) => scripted.slice(i * step, (i + 1) * step))
    : [`${name} here, `, 'turn ', `${seatTurns}. `, 'I read ', 'the room ', 'and ', 'agree.']
  await playFrames(shortReply(text, { parts }), ctx, false)
  if (!ctx.aborted) replay = null
}

function renameFile(file, name) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const rec = { type: 'title', v: 1, title: name, updatedAt: Date.now() }
  let at = -1
  for (let i = 0; i < Math.min(4, lines.length); i++) {
    try {
      if (JSON.parse(lines[i]).type === 'title') {
        at = i
        break
      }
    } catch {
      /* skip */
    }
  }
  if (at >= 0) lines[at] = JSON.stringify(rec)
  else lines.unshift(JSON.stringify(rec))
  writeFileSync(file, lines.join('\n'))
}

const respond = (id, command, extra = {}) => emit({ ...(id ? { id } : {}), type: 'response', command, success: true, ...extra })

async function handleRpc(cmd) {
  const { type, id } = cmd
  switch (type) {
    case 'set_session_name':
      if (!resumeFile) return emit({ ...(id ? { id } : {}), type: 'response', command: type, success: false, error: 'no session' })
      renameFile(resumeFile, String(cmd.name ?? ''))
      return respond(id, type)
    case 'get_available_models':
      return respond(id, type, { data: { models: MODELS } })
    case 'get_state':
      return respond(id, type, { data: { sessionFile: resumeFile, sessionId: 'fake-session', model: state.model, thinkingLevel: state.thinkingLevel } })
    default:
      return emit({ ...(id ? { id } : {}), type: 'response', command: type, success: false, error: `Unknown command: ${type}` })
  }
}

async function handle(cmd) {
  if (RPC_ONLY) return handleRpc(cmd)
  const { type, id } = cmd
  switch (type) {
    case 'set_ask_dialog':
      return respond(id, type, { data: { enabled: cmd.enabled !== false } })
    case 'set_subagent_subscription':
      return respond(id, type, { data: { level: cmd.level ?? 'off' } })
    case 'set_model': {
      log('set-model', { provider: cmd.provider, modelId: cmd.modelId })
      const known = MODELS.find((m) => m.provider === cmd.provider && m.id === cmd.modelId)
      state.model = known ?? { id: String(cmd.modelId), provider: String(cmd.provider), contextWindow: 200000 }
      return respond(id, type, { data: {} })
    }
    case 'set_thinking_level':
      state.thinkingLevel = String(cmd.level)
      return respond(id, type, { data: {} })
    case 'set_fast_mode':
      state.fastModeEnabled = cmd.enabled === true
      return respond(id, type, { data: {} })
    case 'set_session_name':
      state.sessionName = String(cmd.name ?? '')
      return respond(id, type, { data: {} })
    case 'get_state':
      return respond(id, type, {
        data: {
          sessionFile: resumeFile ?? plannedFile,
          sessionId: 'fake-session',
          sessionName: state.sessionName,
          isStreaming: replay !== null,
          isSettled: replay === null,
          messageCount,
          model: state.model,
          thinkingLevel: state.thinkingLevel,
          fastModeEnabled: state.fastModeEnabled,
          contextUsage: { tokens: 42000, contextWindow: state.model.contextWindow ?? 0 },
        },
      })
    case 'prompt': {
      await respond(id, type)
      const text = String(cmd.message ?? '')
      log('prompt', { message: text })
      if (replay) {
        steers.push({ id, text })
        return emit({ type: 'queue_update', steering: steers.map((s) => s.text), followUp: [] })
      }
      const images = Array.isArray(cmd.images) && cmd.images.length ? cmd.images : null
      if (images) log('prompt-images', { count: images.length, mimeTypes: images.map((i) => i.mimeType) })
      const slow = text.includes('[slow]')
      const kw = DIALOG_KEYWORDS.find((k) => text.includes(k))
      // do not await: stdin must keep being served while replaying
      if (kw) void runDialog(id, text, kw, slow)
      else if (roomSeat) void runSeat(id, text, roomSeat)
      else if (images || slow) void runPlain(id, text, images, slow)
      else void runReplay(id, text)
      return
    }
    case 'abort': {
      if (!replay) return respond(id, type)
      const ctx = replay
      ctx.aborted = true
      replay = null
      steers = []
      if (ctx.pendingId && pending.has(ctx.pendingId)) pending.get(ctx.pendingId)({ cancelled: true })
      const t = { promptId: ctx.promptId, text: ctx.text, aborted: false, cur: ctx.assistant, assistant: ctx.assistant, abortId: id }
      // tail's first frame is the aborted assistant message_end: keep the live assistant id
      await playFrames(abortTail, t, false)
      return
    }
    case 'extension_ui_response': {
      log('ui-response', cmd)
      const res = pending.get(cmd.id)
      if (res) res(cmd)
      return
    }
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
  for (const res of pending.values()) res({ cancelled: true })
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
