import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { HindsightLocal, HindsightProblem, HindsightStatus } from '@evaos/contract'
import {
  NATIVE_API_BASE_PORT,
  NATIVE_LABEL,
  NATIVE_UNSUPPORTED,
  installNative,
  localModelFor,
  nativeInfo,
  restartNative,
  type LocalModel,
  type NativeInfo,
  nativePaths,
  stopNative,
  updateNative,
} from './hindsight-native'
import { HindsightError, firstFreePort, lastLine, readText, writeAtomic } from './hindsight-util'

/**
 * Long-term memory for a starter user: Hindsight (https://github.com/vectorize-io/hindsight),
 * wired into omp the way Eva's own is (workflows/hindsight.md): omp's config.yml set to
 * `memory.backend: hindsight` with `hindsight.apiUrl` and `hindsight.bankId`.
 *
 * Default engine: Relay's own install under Application Support, no Docker (hindsight-native.ts).
 * Fallback engine, only when the user asks for it after the native install failed (or on an Intel
 * Mac): the same image Eva's runs in Docker, as `relay-hindsight` on the first free ports from
 * 18888/19999, only ever touched when it carries our label. Neither collides with Eva's own
 * `hindsight` container (8888/9999).
 */

export const HINDSIGHT_IMAGE = 'ghcr.io/vectorize-io/hindsight:latest'
export const HINDSIGHT_LABEL = 'io.relay.hindsight'
export const HINDSIGHT_API_BASE_PORT = NATIVE_API_BASE_PORT
export const HINDSIGHT_UI_BASE_PORT = 19999
const WORKER_ID = 'hindsight-relay'
/** Model Hindsight uses on a ChatGPT login (Codex CLI); the image's default is rejected there. */
const CODEX_MODEL = 'gpt-5.6-luna'

export interface HindsightNames {
  container: string
  volume: string
}
export const DEFAULT_NAMES: HindsightNames = {
  container: 'relay-hindsight',
  volume: 'relay-hindsight-data',
}

export interface DockerResult {
  code: number
  stdout: string
  stderr: string
  /** The command is not installed. */
  missing?: boolean
}

export interface ExecOptions {
  /** Added to the process environment. */
  env?: Record<string, string>
  timeoutMs?: number
}

export interface HindsightDeps {
  docker(args: string[], timeoutMs?: number): Promise<DockerResult>
  /** Runs a command (uv, launchctl, tar). Never rejects. */
  exec(cmd: string, args: string[], o?: ExecOptions): Promise<DockerResult>
  /** Saves `url` to `dest`; rejects with a readable message. */
  download(url: string, dest: string): Promise<void>
  /** Total bytes under a folder (0 when it does not exist). */
  dirSize(dir: string): Promise<number>
  /** Never rejects; status 0 when nothing answered. */
  http(
    method: 'GET' | 'PUT',
    url: string,
    body?: unknown,
  ): Promise<{
    status: number
    /** Parsed JSON of a 2xx reply, when there is one. */ body?: unknown
  }>
  portFree(port: number): Promise<boolean>
  sleep(ms: number): Promise<void>
  homedir: string
  /** omp's agent dir (holds config.yml and .env). */
  agentDir: string
  /** Relay's own config dir (holds the Docker fallback's hindsight.env). */
  configDir: string
  names: HindsightNames
  /** First API port to try; the UI port is tried at the same offset from its own base. */
  apiBasePort: number
  uiBasePort: number
  /** How long to wait for the API to answer after a start. */
  healthTimeoutMs: number
  /** `process.arch`: the native install needs `arm64`. */
  arch: string
  /** The user id launchctl's `gui/<uid>` domain is keyed on. */
  uid: number
  /** `~/Library/Application Support/Relay/hindsight`: venv, Python, uv, models and memories. */
  nativeDir: string
  launchAgentsDir: string
  /** The LaunchAgent label. */
  label: string
  /** Where an existing uv may be; the private one under nativeDir is used when none works. */
  uvCandidates: string[]
  /** Installed memory; decides whether a model can run on this Mac. */
  ramBytes: number
  /** PATH for finding tools a GUI app does not have on its own (codex). */
  toolPath: string
}

export interface HindsightProgress {
  (percent: number | null, line: string): void
}

// ---- omp config.yml -------------------------------------------------------------------------

interface Block {
  key: string | null
  lines: string[]
}

const TOP_KEY = /^([A-Za-z_][\w-]*):/

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [{ key: null, lines: [] }]
  for (const line of text.split('\n')) {
    const m = TOP_KEY.exec(line)
    if (m) blocks.push({ key: m[1]!, lines: [line] })
    else blocks[blocks.length - 1]!.lines.push(line)
  }
  return blocks
}

function joinBlocks(blocks: Block[]): string {
  return blocks.flatMap((b) => b.lines).join('\n')
}

/** Where a block's trailing blank lines start, so inserted lines stay with the block's content. */
function contentEnd(lines: string[]): number {
  let end = lines.length
  while (end > 1 && lines[end - 1]!.trim() === '') end--
  return end
}

/** Removes the `  key:` child (and its deeper-indented lines) from a block. */
function dropChild(lines: string[], key: string): string[] {
  const out: string[] = []
  let skipping = false
  for (const [i, line] of lines.entries()) {
    if (i > 0 && new RegExp(`^  ${key}:`).test(line)) {
      skipping = true
      continue
    }
    if (skipping && (/^\s{3,}\S/.test(line) || /^\s+-\s/.test(line))) continue
    skipping = false
    out.push(line)
  }
  return out
}

function hasChild(lines: string[], key: string): boolean {
  return lines.some((l, i) => i > 0 && new RegExp(`^  ${key}:`).test(l))
}

function childValue(lines: string[], key: string): string | null {
  for (const [i, l] of lines.entries()) {
    const m = i > 0 ? new RegExp(`^  ${key}:\\s*(.*?)\\s*$`).exec(l) : null
    if (m) return m[1]!.replace(/^["']|["']$/g, '')
  }
  return null
}

/** Sets a child in place when it exists, else at the end of the block's content. */
function setChild(lines: string[], key: string, valueLines: string[]): string[] {
  const at = lines.findIndex((l, i) => i > 0 && new RegExp(`^  ${key}:`).test(l))
  if (at < 0) {
    const end = contentEnd(lines)
    return [...lines.slice(0, end), ...valueLines, ...lines.slice(end)]
  }
  const rest = dropChild(lines, key)
  return [...rest.slice(0, at), ...valueLines, ...rest.slice(at)]
}

function ensureBlock(blocks: Block[], key: string): Block {
  let b = blocks.find((x) => x.key === key)
  if (!b) {
    const last = blocks[blocks.length - 1]!
    // Keep a blank line between the previous block and the new one.
    if (last.lines.length > 0 && last.lines[last.lines.length - 1] !== '') last.lines.push('')
    b = { key, lines: [`${key}:`] }
    blocks.push(b)
  } else if (!/^[\w-]+:\s*$/.test(b.lines[0]!)) {
    // An inline value (`memory: {}`): replace with an empty block.
    b.lines = [`${key}:`, ...b.lines.slice(1)]
  }
  return b
}

export interface OmpHindsight {
  apiUrl: string
  bankId: string
  retainContext: string
}

/** Points omp at Hindsight. Keeps every other line and any hindsight.* tweaks the user made. */
export function enableInConfig(text: string, c: OmpHindsight): string {
  const blocks = splitBlocks(text.endsWith('\n') || text === '' ? text : `${text}\n`)
  const mem = ensureBlock(blocks, 'memory')
  mem.lines = setChild(mem.lines, 'backend', ['  backend: hindsight'])
  const hs = ensureBlock(blocks, 'hindsight')
  hs.lines = setChild(hs.lines, 'apiUrl', [`  apiUrl: ${c.apiUrl}`])
  hs.lines = setChild(hs.lines, 'bankId', [`  bankId: ${c.bankId}`])
  if (!hasChild(hs.lines, 'recallTypes')) {
    hs.lines = setChild(hs.lines, 'recallTypes', [
      '  recallTypes:',
      '    - world',
      '    - experience',
      '    - observation',
    ])
  }
  if (!hasChild(hs.lines, 'retainContext')) {
    hs.lines = setChild(hs.lines, 'retainContext', [
      `  retainContext: ${JSON.stringify(c.retainContext)}`,
    ])
  }
  const out = joinBlocks(blocks)
  return out.endsWith('\n') ? out : `${out}\n`
}

/**
 * Takes omp off Hindsight, but only when config.yml points at `apiUrl` (ours). A config that
 * points anywhere else is somebody else's memory server and is left alone.
 */
export function disableInConfig(text: string, apiUrl: string): string {
  const blocks = splitBlocks(text)
  const hs = blocks.find((b) => b.key === 'hindsight')
  if (!hs || childValue(hs.lines, 'apiUrl') !== apiUrl) return text
  const mem = blocks.find((b) => b.key === 'memory')
  if (mem && childValue(mem.lines, 'backend') === 'hindsight') {
    mem.lines = dropChild(mem.lines, 'backend')
    if (mem.lines.slice(1).every((l) => l.trim() === '')) mem.lines = []
  }
  hs.lines = []
  return joinBlocks(blocks).replace(/\n{3,}/g, '\n\n')
}

/** What config.yml says about Hindsight: the backend, url and bank (null when absent). */
export function readConfig(text: string): {
  backend: string | null
  apiUrl: string | null
  bankId: string | null
} {
  const blocks = splitBlocks(text)
  const mem = blocks.find((b) => b.key === 'memory')
  const hs = blocks.find((b) => b.key === 'hindsight')
  return {
    backend: mem ? childValue(mem.lines, 'backend') : null,
    apiUrl: hs ? childValue(hs.lines, 'apiUrl') : null,
    bankId: hs ? childValue(hs.lines, 'bankId') : null,
  }
}

// ---- LLM for Hindsight ----------------------------------------------------------------------

export type LlmChoice =
  | { kind: 'codex' }
  | { kind: 'key'; provider: 'openai' | 'anthropic'; key: string }
  | { kind: 'existing' }
  /** Relay runs a model on this Mac (native install only). */
  | { kind: 'local' }
  | { kind: 'none' }

function envFileValue(text: string | null, name: string): string | null {
  if (text === null) return null
  const m = new RegExp(`^(?:export\\s+)?${name}=(.+)$`, 'm').exec(text)
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, '')
  return v ? v : null
}

/**
 * Which LLM Hindsight reads your conversations with, first match: the model on this Mac when the
 * user asked for it (only ever on request: it is a 17 GB download); the settings from an earlier
 * install (kept so a re-run never asks again); a Codex CLI login (same wiring as Eva's); an API
 * key already in omp's own `.env` (put there by the AI step). `none` means there is nothing yet.
 */
export function pickLlm(i: {
  wantLocal?: boolean
  hasSavedEnv: boolean
  hasCodexAuth: boolean
  ompEnv: string | null
}): LlmChoice {
  if (i.wantLocal) return { kind: 'local' }
  if (i.hasSavedEnv) return { kind: 'existing' }
  if (i.hasCodexAuth) return { kind: 'codex' }
  const openai = envFileValue(i.ompEnv, 'OPENAI_API_KEY')
  if (openai) return { kind: 'key', provider: 'openai', key: openai }
  const anthropic = envFileValue(i.ompEnv, 'ANTHROPIC_API_KEY')
  if (anthropic) return { kind: 'key', provider: 'anthropic', key: anthropic }
  return { kind: 'none' }
}

/** The `--env-file` text for a choice (never contains anything for `existing`/`none`). */
export function llmEnvText(c: LlmChoice): string | null {
  if (c.kind === 'codex') {
    return `HINDSIGHT_API_LLM_PROVIDER=openai-codex\nHINDSIGHT_API_LLM_MODEL=${CODEX_MODEL}\n`
  }
  if (c.kind === 'key') {
    return `HINDSIGHT_API_LLM_PROVIDER=${c.provider}\nHINDSIGHT_API_LLM_API_KEY=${c.key}\n`
  }
  return null
}

// ---- why memory is not saving ---------------------------------------------------------------

interface OperationRow {
  status?: unknown
  error_message?: unknown
}

/** A login that no longer works, as the providers and Hindsight word it. */
const LOGIN_ERROR =
  /authentication|auth(?:orization)? (?:failed|error)|refresh_token|unauthori[sz]ed|\b40[13]\b|expired|invalid.{0,12}(?:token|api key)|codex (?:auth )?login/i

/**
 * Reads Hindsight's recent operations (newest first) and says why saving stopped, when it did:
 * the newest operation that finished (not still pending) is the one that counts, so one old
 * failure does not nag after a later success.
 */
export function classifyOperations(
  ops: readonly OperationRow[],
  usingChatGpt: boolean,
): HindsightProblem | null {
  const last = ops.find((o) => o.status === 'completed' || o.status === 'failed')
  if (!last || last.status !== 'failed') return null
  const detail = typeof last.error_message === 'string' ? last.error_message : ''
  if (LOGIN_ERROR.test(detail)) {
    return usingChatGpt
      ? {
          kind: 'login',
          message: "Memory isn't saving: your ChatGPT sign-in for memory expired.",
          fix: 'sign-in',
        }
      : {
          kind: 'login',
          message: "Memory isn't saving: the AI key for memory was refused.",
          fix: 'restart',
        }
  }
  return {
    kind: 'llm',
    message: "Memory isn't saving: the AI model for memory returned an error.",
    fix: 'restart',
  }
}

// ---- docker -----------------------------------------------------------------------------------

export interface ContainerInfo {
  running: boolean
  ours: boolean
  apiPort: number | null
  uiPort: number | null
  /** Both ports are published on 127.0.0.1 and nowhere wider. */
  loopbackOnly: boolean
}

interface InspectJson {
  State?: { Running?: boolean }
  Config?: { Labels?: Record<string, string> | null }
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
  }
}

export function parseInspect(stdout: string): ContainerInfo | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const c = (Array.isArray(parsed) ? parsed[0] : null) as InspectJson | null
  if (!c) return null
  const bindings = c.HostConfig?.PortBindings ?? {}
  const port = (container: string): { port: number | null; loopback: boolean } => {
    const b = bindings[`${container}/tcp`]?.[0]
    const n = b?.HostPort ? Number.parseInt(b.HostPort, 10) : NaN
    return { port: Number.isFinite(n) ? n : null, loopback: b?.HostIp === '127.0.0.1' }
  }
  const api = port('8888')
  const ui = port('9999')
  return {
    running: c.State?.Running === true,
    ours: c.Config?.Labels?.[HINDSIGHT_LABEL] === '1',
    apiPort: api.port,
    uiPort: ui.port,
    loopbackOnly: api.loopback && (ui.port === null || ui.loopback),
  }
}

export interface RunPlan {
  names: HindsightNames
  apiPort: number
  uiPort: number
  envFile: string
  /** Mount the user's Codex CLI login (Eva's wiring). */
  codexDir: string | null
}

/** The `docker run` arguments. Ports are 127.0.0.1 only; this is the one place that is decided. */
export function dockerRunArgs(p: RunPlan): string[] {
  return [
    'run',
    '-d',
    '--name',
    p.names.container,
    '--hostname',
    WORKER_ID,
    '--restart',
    'unless-stopped',
    '--label',
    `${HINDSIGHT_LABEL}=1`,
    '-p',
    `127.0.0.1:${p.apiPort}:8888`,
    '-p',
    `127.0.0.1:${p.uiPort}:9999`,
    '-v',
    `${p.names.volume}:/home/hindsight/.pg0`,
    ...(p.codexDir ? ['-v', `${p.codexDir}:/home/hindsight/.codex`] : []),
    '--env-file',
    p.envFile,
    '-e',
    `HINDSIGHT_API_WORKER_ID=${WORKER_ID}`,
    HINDSIGHT_IMAGE,
  ]
}

// ---- orchestration ----------------------------------------------------------------------------

const ompConfig = (d: HindsightDeps): string => path.join(d.agentDir, 'config.yml')
/** The Docker fallback's LLM settings; the native install keeps its own beside its venv. */
const dockerEnvPath = (d: HindsightDeps): string => path.join(d.configDir, 'hindsight.env')
const codexAuth = (d: HindsightDeps): string => path.join(d.homedir, '.codex', 'auth.json')

function hasSavedEnv(d: HindsightDeps): boolean {
  return fs.existsSync(nativePaths(d).env) || fs.existsSync(dockerEnvPath(d))
}

async function inspect(
  d: HindsightDeps,
): Promise<{ info: ContainerInfo | null; docker: 'missing' | 'down' | 'ok' }> {
  const r = await d.docker(['inspect', d.names.container], 15_000)
  if (r.missing) return { info: null, docker: 'missing' }
  const info = r.code === 0 ? parseInspect(r.stdout) : null
  if (r.code !== 0 && !/no such (object|container)/i.test(r.stderr)) {
    return { info: null, docker: 'down' }
  }
  return { info, docker: 'ok' }
}

/** First assistant in the home base's registry: its id names the bank, its title goes in the context. */
export function firstAssistant(root: string): { id: string; title: string } | null {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(root, '.omp/assistant/agents.json'), 'utf8'),
    ) as {
      agents?: Array<{ id?: unknown; title?: unknown }>
    }
    const a = j.agents?.[0]
    if (typeof a?.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(a.id)) return null
    return { id: a.id, title: typeof a.title === 'string' && a.title ? a.title : a.id }
  } catch {
    return null
  }
}

/** What is on hand for Hindsight to read with, as the status reports it. */
function llmOnHand(d: HindsightDeps): HindsightStatus['llm'] {
  const c = pickLlm({
    hasSavedEnv: hasSavedEnv(d),
    hasCodexAuth: fs.existsSync(codexAuth(d)),
    ompEnv: readText(path.join(d.agentDir, '.env')),
  })
  return c.kind === 'existing' ? 'saved' : c.kind === 'codex' || c.kind === 'key' ? c.kind : 'none'
}

/**
 * The model on this Mac: installed and how it is doing, or offered when this Mac can run one and a
 * ChatGPT login does not already do the job.
 */
function localStatus(
  d: HindsightDeps,
  llm: HindsightStatus['llm'],
  native: NativeInfo,
): HindsightLocal | null {
  const m = d.arch === 'arm64' ? localModelFor(d.ramBytes) : null
  const sizes = { downloadBytes: m?.downloadBytes ?? 0, ramBytes: m?.ramBytes ?? 0 }
  if (native.local) {
    return { model: native.local.model, ...sizes, installed: true, running: native.localRunning }
  }
  if (m !== null && llm !== 'codex') {
    return { model: m.repo, ...sizes, installed: false, running: false }
  }
  return null
}

function usesChatGpt(envFile: string): boolean {
  return /HINDSIGHT_API_LLM_PROVIDER=openai-codex/.test(readText(envFile) ?? '')
}

/**
 * Why memory is not saving, when it is. Only for a service omp already points at: it is stopped,
 * its model is down, or Hindsight's own latest finished operation failed (an expired login shows
 * up there as a failed retain).
 */
async function findProblem(
  d: HindsightDeps,
  s: {
    configured: boolean
    running: boolean
    healthy: boolean
    apiUrl: string | null
    bankId: string | null
    chatGpt: boolean
    localDown: boolean
  },
): Promise<HindsightProblem | null> {
  if (!s.configured) return null
  if (!s.running || !s.healthy) {
    return { kind: 'down', message: "Memory isn't saving: it is not running.", fix: 'restart' }
  }
  if (s.localDown) {
    return {
      kind: 'llm',
      message: "Memory isn't saving: the model on this Mac is not running.",
      fix: 'restart',
    }
  }
  if (s.apiUrl === null || s.bankId === null) return null
  const r = await d.http('GET', `${s.apiUrl}/v1/default/banks/${s.bankId}/operations?limit=10`)
  const ops = (r.body as { operations?: unknown } | undefined)?.operations
  return Array.isArray(ops) ? classifyOperations(ops as OperationRow[], s.chatGpt) : null
}

export async function hindsightStatus(d: HindsightDeps): Promise<HindsightStatus> {
  const cfg = readConfig(readText(ompConfig(d)) ?? '')
  const llm = llmOnHand(d)
  const nativeSupported = d.arch === 'arm64'

  const native = await nativeInfo(d)
  if (native.installed) {
    const apiUrl = native.apiPort ? `http://127.0.0.1:${native.apiPort}` : null
    const healthy =
      apiUrl !== null && native.running && (await d.http('GET', `${apiUrl}/health`)).status === 200
    const configured = apiUrl !== null && cfg.backend === 'hindsight' && cfg.apiUrl === apiUrl
    const bankId = cfg.apiUrl !== null && cfg.apiUrl === apiUrl ? cfg.bankId : null
    return {
      engine: 'native',
      nativeSupported,
      docker: 'unchecked',
      service: native.running ? 'running' : 'stopped',
      healthy,
      apiUrl,
      uiUrl: null,
      bankId,
      configured,
      llm,
      local: localStatus(d, llm, native),
      problem: await findProblem(d, {
        configured,
        running: native.running,
        healthy,
        apiUrl,
        bankId,
        chatGpt: usesChatGpt(nativePaths(d).env),
        localDown: native.local !== null && !native.localRunning,
      }),
      version: native.version,
      diskBytes: await d.dirSize(nativePaths(d).dir),
    }
  }

  const { info, docker } = await inspect(d)
  const ours = info?.ours === true ? info : null
  const apiUrl = ours?.apiPort ? `http://127.0.0.1:${ours.apiPort}` : null
  const healthy =
    apiUrl !== null &&
    ours?.running === true &&
    (await d.http('GET', `${apiUrl}/health`)).status === 200
  const configured = apiUrl !== null && cfg.backend === 'hindsight' && cfg.apiUrl === apiUrl
  const bankId = cfg.apiUrl !== null && cfg.apiUrl === apiUrl ? cfg.bankId : null
  return {
    engine: ours === null ? 'none' : 'docker',
    nativeSupported,
    docker,
    service: ours === null ? 'none' : ours.running ? 'running' : 'stopped',
    healthy,
    apiUrl,
    uiUrl: ours?.uiPort ? `http://127.0.0.1:${ours.uiPort}` : null,
    bankId,
    configured,
    llm,
    local: localStatus(d, llm, native),
    problem: await findProblem(d, {
      configured,
      running: ours?.running === true,
      healthy,
      apiUrl,
      bankId,
      chatGpt: usesChatGpt(dockerEnvPath(d)),
      localDown: false,
    }),
    version: null,
    diskBytes: null,
  }
}

export interface InstallInput {
  root: string
  userName?: string
  /** `native` (Relay's own install, the default) or `docker` (the fallback). */
  engine?: 'native' | 'docker'
  /** `local`: also run a model on this Mac for Hindsight to read with (native, 32 GB or more). */
  llm?: 'auto' | 'local'
}

async function waitHealthy(d: HindsightDeps, apiUrl: string): Promise<boolean> {
  const deadline = Date.now() + d.healthTimeoutMs
  while (Date.now() < deadline) {
    if ((await d.http('GET', `${apiUrl}/health`)).status === 200) return true
    await d.sleep(2000)
  }
  return false
}

const needsKey = (): HindsightError =>
  new HindsightError(
    'Hindsight needs an AI key or a ChatGPT sign-in to read and summarise your conversations. Add one in the AI step (Settings, Setup), then try again.',
  )

/**
 * Sets Hindsight up, or finishes setting it up: every step checks what is already there. Throws a
 * HindsightError whose message is safe to show; whatever was installed is left for the next try.
 */
export async function installHindsight(
  d: HindsightDeps,
  input: InstallInput,
  progress: HindsightProgress,
): Promise<{ apiUrl: string; uiUrl: string | null; bankId: string }> {
  const assistant = firstAssistant(input.root)
  if (!assistant) {
    throw new HindsightError(
      'Your assistants file was not found, so there is no bank to create yet.',
    )
  }
  const engine = input.engine ?? 'native'
  if (engine === 'native' && d.arch !== 'arm64') throw new HindsightError(NATIVE_UNSUPPORTED)

  // The LLM: decide before touching anything, so a missing account fails before a download.
  const wantLocal = input.llm === 'local'
  let localPlan: LocalModel | null = null
  if (wantLocal) {
    if (engine !== 'native') {
      throw new HindsightError(
        'The model on this Mac only runs with the Relay install, not Docker.',
      )
    }
    localPlan = localModelFor(d.ramBytes)
    if (localPlan === null) {
      throw new HindsightError(
        `A model that is good enough for memory needs a Mac with 32 GB of memory or more. This one has ${Math.round(d.ramBytes / 1024 ** 3)} GB.`,
      )
    }
  }
  const llm = pickLlm({
    wantLocal,
    hasSavedEnv: hasSavedEnv(d),
    hasCodexAuth: fs.existsSync(codexAuth(d)),
    ompEnv: readText(path.join(d.agentDir, '.env')),
  })

  let apiUrl: string
  let uiUrl: string | null = null
  if (engine === 'native') {
    if (llm.kind === 'none' && !(await nativeInfo(d)).installed) throw needsKey()
    apiUrl = await installNative(
      d,
      { text: llmEnvText(llm), legacy: readText(dockerEnvPath(d)) },
      localPlan,
      progress,
    )
  } else {
    ;({ apiUrl, uiUrl } = await installDocker(d, llm, progress))
    // The native install that did not work is not left behind to win over this one.
    if ((await nativeInfo(d)).installed) await stopNative(d, 'remove')
  }

  progress(90, `Creating the memory bank "${assistant.id}"`)
  const bank = await d.http('PUT', `${apiUrl}/v1/default/banks/${assistant.id}`, {
    name: assistant.title,
  })
  if (bank.status < 200 || bank.status >= 300) {
    throw new HindsightError(`Hindsight would not create the bank (HTTP ${bank.status}).`)
  }

  progress(96, 'Pointing your assistant at it')
  const who = input.userName?.trim() || 'the user'
  const next = enableInConfig(readText(ompConfig(d)) ?? '', {
    apiUrl,
    bankId: assistant.id,
    retainContext: `Conversation between ${who} and their assistant ${assistant.title} (omp session); ${who}'s own statements are their decisions and preferences`,
  })
  writeAtomic(ompConfig(d), next)
  progress(100, 'Done')
  return { apiUrl, uiUrl, bankId: assistant.id }
}

/** The Docker fallback: pulls the image and runs the labelled container; returns its urls. */
async function installDocker(
  d: HindsightDeps,
  llm: LlmChoice,
  progress: HindsightProgress,
): Promise<{ apiUrl: string; uiUrl: string }> {
  progress(5, 'Checking Docker')
  const first = await inspect(d)
  if (first.docker === 'missing') {
    throw new HindsightError(
      'Docker is not installed. Install Docker Desktop or OrbStack, then try again.',
    )
  }
  if (first.docker === 'down') {
    throw new HindsightError(
      'Docker is installed but not running. Open it, wait for it to start, then try again.',
    )
  }
  if (first.info && !first.info.ours) {
    throw new HindsightError(
      `A container named ${d.names.container} already exists and Relay did not create it, so it was left alone.`,
    )
  }
  if (llm.kind === 'none' && !first.info) throw needsKey()

  let info = first.info
  if (info && !info.loopbackOnly) {
    throw new HindsightError(
      `${d.names.container} is published beyond this Mac. Remove it from Settings, then set it up again.`,
    )
  }

  if (!info) {
    progress(15, 'Looking for the Hindsight image')
    const have = await d.docker(['image', 'inspect', HINDSIGHT_IMAGE], 30_000)
    if (have.code !== 0) {
      progress(20, 'Downloading Hindsight (about 3.5 GB, a few minutes)')
      const pull = await d.docker(['pull', HINDSIGHT_IMAGE], 30 * 60_000)
      if (pull.code !== 0) {
        throw new HindsightError(
          `Downloading the Hindsight image failed: ${lastLine(pull.stderr || pull.stdout)}`,
        )
      }
    }
    progress(55, 'Creating the memory volume')
    const vol = await d.docker(['volume', 'create', d.names.volume], 30_000)
    if (vol.code !== 0)
      throw new HindsightError(`Could not create the volume: ${lastLine(vol.stderr)}`)

    progress(60, 'Choosing ports')
    const apiPort = await firstFreePort(d.apiBasePort, d.portFree)
    const uiPort = await firstFreePort(d.uiBasePort, d.portFree, new Set([apiPort]))

    const envText = llmEnvText(llm)
    if (envText !== null) writeAtomic(dockerEnvPath(d), envText, 0o600)

    progress(65, 'Starting Hindsight')
    const started = await d.docker(
      dockerRunArgs({
        names: d.names,
        apiPort,
        uiPort,
        envFile: dockerEnvPath(d),
        codexDir:
          (llm.kind === 'codex' || (llm.kind === 'existing' && envIsCodex(d))) &&
          fs.existsSync(codexAuth(d))
            ? path.join(d.homedir, '.codex')
            : null,
      }),
      120_000,
    )
    if (started.code !== 0)
      throw new HindsightError(`Could not start Hindsight: ${lastLine(started.stderr)}`)
    info = { running: true, ours: true, apiPort, uiPort, loopbackOnly: true }
  } else if (!info.running) {
    progress(40, 'Starting Hindsight')
    const start = await d.docker(['start', d.names.container], 60_000)
    if (start.code !== 0)
      throw new HindsightError(`Could not start Hindsight: ${lastLine(start.stderr)}`)
  }

  const apiUrl = `http://127.0.0.1:${info.apiPort}`
  progress(70, 'Waiting for Hindsight to answer (the first start takes a minute)')
  if (!(await waitHealthy(d, apiUrl))) {
    throw new HindsightError(
      `Hindsight did not answer at ${apiUrl}. Check the container's log with: docker logs ${d.names.container}`,
    )
  }
  return { apiUrl, uiUrl: `http://127.0.0.1:${info.uiPort}` }
}

function envIsCodex(d: HindsightDeps): boolean {
  return /HINDSIGHT_API_LLM_PROVIDER=openai-codex/.test(readText(dockerEnvPath(d)) ?? '')
}

/** Starts the service again (a crash, a stopped model, or after Turn off), keeping every setting. */
export async function restartHindsight(
  d: HindsightDeps,
  progress: HindsightProgress,
): Promise<void> {
  if ((await nativeInfo(d)).installed) {
    await restartNative(d, progress)
  } else {
    progress(20, 'Restarting the Docker container')
    const r = await d.docker(['restart', d.names.container], 120_000)
    if (r.code !== 0) throw new HindsightError(`Docker said: ${lastLine(r.stderr)}`)
  }
  progress(100, 'Done')
}

/**
 * Signs in to ChatGPT again for memory: `codex login` opens the browser and rewrites
 * ~/.codex/auth.json, which Hindsight reads on its next call (no restart needed).
 */
export async function reloginHindsight(
  d: HindsightDeps,
  progress: HindsightProgress,
): Promise<void> {
  progress(10, 'Opening the ChatGPT sign-in in your browser')
  const r = await d.exec('codex', ['login'], {
    env: { PATH: d.toolPath },
    timeoutMs: 5 * 60_000,
  })
  if (r.missing) {
    throw new HindsightError(
      'The codex command was not found, so Relay cannot sign in for you. Run "codex login" in Terminal, then try again.',
    )
  }
  if (r.code !== 0) {
    throw new HindsightError(
      `The ChatGPT sign-in did not finish: ${lastLine(r.stderr || r.stdout)}`,
    )
  }
  progress(100, 'Done')
}

/** Upgrades the native install to the newest hindsight-api and restarts it. */
export async function updateHindsight(
  d: HindsightDeps,
  progress: HindsightProgress,
): Promise<{ from: string; to: string }> {
  const r = await updateNative(d, progress)
  progress(100, 'Done')
  return r
}

/**
 * `disable` stops the service and takes omp off it; the memories stay. `remove` also deletes the
 * install (native: the whole folder; Docker: container, volume and saved key). Docker is only
 * touched when our own labelled container is there.
 */
export async function removeHindsight(
  d: HindsightDeps,
  action: 'disable' | 'remove',
  progress: HindsightProgress,
): Promise<void> {
  progress(10, 'Checking what is installed')
  const native = await nativeInfo(d)
  const docker = await inspect(d)
  if (!native.installed) {
    if (docker.docker === 'down') {
      throw new HindsightError('Docker is not running. Open Docker and try again.')
    }
    if (docker.info && !docker.info.ours) {
      throw new HindsightError(
        `${d.names.container} was not created by Relay, so it was left alone.`,
      )
    }
  }
  const container = docker.info?.ours === true ? docker.info : null

  progress(30, 'Switching your assistant back to its own memory')
  const cfgPath = ompConfig(d)
  const text = readText(cfgPath)
  if (text !== null) {
    const next = [native.apiPort, container?.apiPort ?? null].reduce<string>(
      (t, port) => (port === null ? t : disableInConfig(t, `http://127.0.0.1:${port}`)),
      text,
    )
    if (next !== text) writeAtomic(cfgPath, next)
  }

  if (native.installed) {
    progress(
      55,
      action === 'remove' ? 'Deleting the install and its memories' : 'Stopping Hindsight',
    )
    await stopNative(d, action)
  }
  if (container) {
    progress(65, action === 'remove' ? 'Removing the container' : 'Stopping the Docker container')
    const r = await d.docker(
      action === 'remove' ? ['rm', '-f', d.names.container] : ['stop', d.names.container],
      60_000,
    )
    if (r.code !== 0) throw new HindsightError(`Docker said: ${lastLine(r.stderr)}`)
  }
  if (action === 'remove') {
    if (docker.docker === 'ok' && (container || !native.installed)) {
      progress(80, 'Deleting the saved memories')
      const v = await d.docker(['volume', 'rm', '-f', d.names.volume], 60_000)
      if (v.code !== 0) throw new HindsightError(`Docker said: ${lastLine(v.stderr)}`)
    }
    fs.rmSync(dockerEnvPath(d), { force: true })
  }
  progress(100, 'Done')
}

// ---- real dependencies ----------------------------------------------------------------------

/** Where Docker's CLI lives for each of the usual installs; a GUI app's PATH has none of them. */
export function dockerPath(base: string, homedir: string): string {
  const extra = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/Applications/Docker.app/Contents/Resources/bin',
    path.join(homedir, '.docker/bin'),
    path.join(homedir, '.orbstack/bin'),
  ]
  return [...new Set([...base.split(':').filter(Boolean), ...extra])].join(':')
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<DockerResult> {
  const { promise, resolve } = Promise.withResolvers<DockerResult>()
  execFile(
    cmd,
    args,
    { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr })
      const e = err as NodeJS.ErrnoException & { code?: number | string }
      if (e.code === 'ENOENT') {
        return resolve({ code: 127, stdout: '', stderr: `${cmd} not found`, missing: true })
      }
      resolve({
        code: typeof e.code === 'number' ? e.code : 1,
        stdout,
        stderr: stderr || e.message,
      })
    },
  )
  return promise
}

export function realDeps(o: {
  homedir: string
  agentDir: string
  configDir: string
  pathEnv: string
  names?: HindsightNames
  apiBasePort?: number
  uiBasePort?: number
  nativeDir?: string
  launchAgentsDir?: string
  label?: string
  uvCandidates?: string[]
  arch?: string
  healthTimeoutMs?: number
  ramBytes?: number
}): HindsightDeps {
  const dockerEnv = { ...process.env, PATH: dockerPath(o.pathEnv, o.homedir) }
  return {
    docker: (args, timeoutMs = 60_000) => run('docker', args, dockerEnv, timeoutMs),
    exec: (cmd, args, x = {}) =>
      run(cmd, args, { ...process.env, ...x.env }, x.timeoutMs ?? 60_000),
    download: async (url, dest) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body as WebReadableStream), fs.createWriteStream(dest))
    },
    dirSize: async (dir) => {
      if (!fs.existsSync(dir)) return 0
      const r = await run('/usr/bin/du', ['-sk', dir], process.env, 60_000)
      const kb = Number.parseInt(r.stdout, 10)
      return Number.isFinite(kb) ? kb * 1024 : 0
    },
    http: async (method, url, body) => {
      try {
        const res = await fetch(url, {
          method,
          signal: AbortSignal.timeout(10_000),
          ...(body !== undefined
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        })
        const parsed = res.ok ? ((await res.json().catch(() => undefined)) as unknown) : undefined
        return { status: res.status, ...(parsed !== undefined ? { body: parsed } : {}) }
      } catch {
        return { status: 0 }
      }
    },
    portFree: (port) => {
      const { promise, resolve } = Promise.withResolvers<boolean>()
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
      return promise
    },
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, ms)
      return promise
    },
    homedir: o.homedir,
    agentDir: o.agentDir,
    configDir: o.configDir,
    names: o.names ?? DEFAULT_NAMES,
    apiBasePort: o.apiBasePort ?? HINDSIGHT_API_BASE_PORT,
    uiBasePort: o.uiBasePort ?? HINDSIGHT_UI_BASE_PORT,
    healthTimeoutMs: o.healthTimeoutMs ?? 15 * 60_000,
    ramBytes: o.ramBytes ?? os.totalmem(),
    toolPath: [
      dockerPath(o.pathEnv, o.homedir),
      path.join(o.homedir, '.bun/bin'),
      path.join(o.homedir, '.local/bin'),
      path.join(o.homedir, '.npm-global/bin'),
    ].join(':'),
    arch: o.arch ?? process.arch,
    uid: process.getuid?.() ?? 0,
    nativeDir: o.nativeDir ?? path.join(o.homedir, 'Library/Application Support/Relay/hindsight'),
    launchAgentsDir: o.launchAgentsDir ?? path.join(o.homedir, 'Library/LaunchAgents'),
    label: o.label ?? NATIVE_LABEL,
    uvCandidates: o.uvCandidates ?? [
      '/opt/homebrew/bin/uv',
      '/usr/local/bin/uv',
      path.join(o.homedir, '.local/bin/uv'),
      path.join(o.homedir, '.cargo/bin/uv'),
    ],
  }
}
