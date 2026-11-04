import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import type { HindsightStatus } from '@evaos/contract'

/**
 * Long-term memory for a starter user: Hindsight (https://github.com/vectorize-io/hindsight) in
 * Docker, wired into omp the way Eva's own is (workflows/hindsight.md): same image, a named volume
 * at /home/hindsight/.pg0, ports published on 127.0.0.1 only, a fixed worker id, and omp's
 * config.yml set to `memory.backend: hindsight` with `hindsight.apiUrl` and `hindsight.bankId`.
 *
 * Names and ports never collide with Eva's `hindsight` container (8888/9999): ours is
 * `relay-hindsight` on the first free ports from 18888/19999, and it is only ever touched when it
 * carries our label.
 */

export const HINDSIGHT_IMAGE = 'ghcr.io/vectorize-io/hindsight:latest'
export const HINDSIGHT_LABEL = 'io.relay.hindsight'
export const HINDSIGHT_API_BASE_PORT = 18888
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
  /** The docker CLI is not installed. */
  missing?: boolean
}

export interface HindsightDeps {
  docker(args: string[], timeoutMs?: number): Promise<DockerResult>
  /** Never rejects; status 0 when nothing answered. */
  http(method: 'GET' | 'PUT', url: string, body?: unknown): Promise<{ status: number }>
  portFree(port: number): Promise<boolean>
  sleep(ms: number): Promise<void>
  homedir: string
  /** omp's agent dir (holds config.yml and .env). */
  agentDir: string
  /** Relay's own config dir (holds hindsight.env). */
  configDir: string
  names: HindsightNames
  /** First API port to try; the UI port is tried at the same offset from its own base. */
  apiBasePort: number
  uiBasePort: number
  /** How long to wait for the API to answer after a start. */
  healthTimeoutMs: number
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
  | { kind: 'none' }

function envFileValue(text: string | null, name: string): string | null {
  if (text === null) return null
  const m = new RegExp(`^(?:export\\s+)?${name}=(.+)$`, 'm').exec(text)
  const v = m?.[1]?.trim().replace(/^["']|["']$/g, '')
  return v ? v : null
}

/**
 * Which LLM Hindsight runs on, first match: a key the user just typed; the key file from an earlier
 * install (kept so a re-run never asks again); a Codex CLI login (same wiring as Eva's); an API key
 * already in omp's own `.env`. `none` means the wizard has to ask for a key.
 */
export function pickLlm(i: {
  typed?: { provider: 'openai' | 'anthropic'; key: string }
  hasSavedEnv: boolean
  hasCodexAuth: boolean
  ompEnv: string | null
}): LlmChoice {
  if (i.typed) return { kind: 'key', provider: i.typed.provider, key: i.typed.key }
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

/** First `base`, `base+1`, ... for which `free` says yes. Gives up after `tries`. */
export async function firstFreePort(
  base: number,
  free: (port: number) => Promise<boolean>,
  taken: ReadonlySet<number> = new Set(),
  tries = 100,
): Promise<number> {
  for (let p = base; p < base + tries; p++) {
    if (!taken.has(p) && (await free(p))) return p
  }
  throw new Error(`No free port found from ${base}.`)
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

export class HindsightError extends Error {}

const ompConfig = (d: HindsightDeps): string => path.join(d.agentDir, 'config.yml')
const envPath = (d: HindsightDeps): string => path.join(d.configDir, 'hindsight.env')
const codexAuth = (d: HindsightDeps): string => path.join(d.homedir, '.codex', 'auth.json')

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function writeAtomic(p: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, mode !== undefined ? { mode } : undefined)
  fs.renameSync(tmp, p)
}

async function inspect(
  d: HindsightDeps,
): Promise<{ info: ContainerInfo | null; docker: HindsightStatus['docker'] }> {
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

export async function hindsightStatus(d: HindsightDeps): Promise<HindsightStatus> {
  const { info, docker } = await inspect(d)
  const cfg = readConfig(readText(ompConfig(d)) ?? '')
  const ours = info?.ours === true ? info : null
  const apiUrl = ours?.apiPort ? `http://127.0.0.1:${ours.apiPort}` : null
  const healthy =
    apiUrl !== null &&
    ours?.running === true &&
    (await d.http('GET', `${apiUrl}/health`)).status === 200
  const llm = pickLlm({
    hasSavedEnv: fs.existsSync(envPath(d)),
    hasCodexAuth: fs.existsSync(codexAuth(d)),
    ompEnv: readText(path.join(d.agentDir, '.env')),
  })
  return {
    docker,
    container: ours === null ? 'none' : ours.running ? 'running' : 'stopped',
    healthy,
    apiUrl,
    uiUrl: ours?.uiPort ? `http://127.0.0.1:${ours.uiPort}` : null,
    bankId: cfg.apiUrl !== null && cfg.apiUrl === apiUrl ? cfg.bankId : null,
    configured: apiUrl !== null && cfg.backend === 'hindsight' && cfg.apiUrl === apiUrl,
    llmReady: llm.kind !== 'none',
  }
}

export interface InstallInput {
  root: string
  userName?: string
  key?: string
  keyProvider?: 'openai' | 'anthropic'
}

async function waitHealthy(d: HindsightDeps, apiUrl: string): Promise<boolean> {
  const deadline = Date.now() + d.healthTimeoutMs
  while (Date.now() < deadline) {
    if ((await d.http('GET', `${apiUrl}/health`)).status === 200) return true
    await d.sleep(2000)
  }
  return false
}

/**
 * Sets Hindsight up, or finishes setting it up: every step checks what is already there. Throws a
 * HindsightError whose message is safe to show; the container is left in place for the next try.
 */
export async function installHindsight(
  d: HindsightDeps,
  input: InstallInput,
  progress: HindsightProgress,
): Promise<{ apiUrl: string; uiUrl: string; bankId: string }> {
  const assistant = firstAssistant(input.root)
  if (!assistant) {
    throw new HindsightError(
      'Your assistants file was not found, so there is no bank to create yet.',
    )
  }

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

  // The LLM: decide before touching anything, so a missing key fails before a download.
  const typed = input.key
    ? { provider: input.keyProvider ?? 'openai', key: input.key.trim() }
    : undefined
  const llm = pickLlm({
    ...(typed ? { typed } : {}),
    hasSavedEnv: fs.existsSync(envPath(d)),
    hasCodexAuth: fs.existsSync(codexAuth(d)),
    ompEnv: readText(path.join(d.agentDir, '.env')),
  })
  if (llm.kind === 'none' && !first.info) {
    throw new HindsightError(
      'Hindsight needs an AI key to read and summarise your conversations. Paste one to continue.',
    )
  }

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
      progress(20, 'Downloading Hindsight (about 2 GB, a few minutes)')
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
    if (envText !== null) writeAtomic(envPath(d), envText, 0o600)

    progress(65, 'Starting Hindsight')
    const run = await d.docker(
      dockerRunArgs({
        names: d.names,
        apiPort,
        uiPort,
        envFile: envPath(d),
        codexDir:
          (llm.kind === 'codex' || (llm.kind === 'existing' && envIsCodex(d))) &&
          fs.existsSync(codexAuth(d))
            ? path.join(d.homedir, '.codex')
            : null,
      }),
      120_000,
    )
    if (run.code !== 0)
      throw new HindsightError(`Could not start Hindsight: ${lastLine(run.stderr)}`)
    info = { running: true, ours: true, apiPort, uiPort, loopbackOnly: true }
  } else {
    if (!info.running) {
      progress(40, 'Starting Hindsight')
      const start = await d.docker(['start', d.names.container], 60_000)
      if (start.code !== 0)
        throw new HindsightError(`Could not start Hindsight: ${lastLine(start.stderr)}`)
    }
  }

  const apiUrl = `http://127.0.0.1:${info.apiPort}`
  const uiUrl = `http://127.0.0.1:${info.uiPort}`
  progress(70, 'Waiting for Hindsight to answer (the first start takes a minute)')
  if (!(await waitHealthy(d, apiUrl))) {
    throw new HindsightError(
      `Hindsight did not answer at ${apiUrl}. Check the container's log with: docker logs ${d.names.container}`,
    )
  }

  progress(85, `Creating the memory bank "${assistant.id}"`)
  const bank = await d.http('PUT', `${apiUrl}/v1/default/banks/${assistant.id}`, {
    name: assistant.title,
  })
  if (bank.status < 200 || bank.status >= 300) {
    throw new HindsightError(`Hindsight would not create the bank (HTTP ${bank.status}).`)
  }

  progress(95, 'Pointing your assistant at it')
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

function envIsCodex(d: HindsightDeps): boolean {
  return /HINDSIGHT_API_LLM_PROVIDER=openai-codex/.test(readText(envPath(d)) ?? '')
}

function lastLine(s: string): string {
  return s.trim().split('\n').pop()?.trim() || 'no details'
}

/**
 * `disable` stops the container and takes omp off it; the memories stay. `remove` also deletes the
 * container, the volume and the saved key. Only our own labelled container is ever touched.
 */
export async function removeHindsight(
  d: HindsightDeps,
  action: 'disable' | 'remove',
  progress: HindsightProgress,
): Promise<void> {
  progress(10, 'Checking Docker')
  const { info, docker } = await inspect(d)
  if (docker !== 'ok') {
    throw new HindsightError('Docker is not running. Open Docker and try again.')
  }
  if (info && !info.ours) {
    throw new HindsightError(`${d.names.container} was not created by Relay, so it was left alone.`)
  }

  progress(30, 'Switching your assistant back to its own memory')
  const cfgPath = ompConfig(d)
  const text = readText(cfgPath)
  const url = info?.apiPort ? `http://127.0.0.1:${info.apiPort}` : null
  if (text !== null && url !== null) {
    const next = disableInConfig(text, url)
    if (next !== text) writeAtomic(cfgPath, next)
  }

  if (info) {
    progress(60, action === 'remove' ? 'Removing the container' : 'Stopping Hindsight')
    const r = await d.docker(
      action === 'remove' ? ['rm', '-f', d.names.container] : ['stop', d.names.container],
      60_000,
    )
    if (r.code !== 0) throw new HindsightError(`Docker said: ${lastLine(r.stderr)}`)
  }
  if (action === 'remove') {
    progress(80, 'Deleting the saved memories')
    const v = await d.docker(['volume', 'rm', '-f', d.names.volume], 60_000)
    if (v.code !== 0) throw new HindsightError(`Docker said: ${lastLine(v.stderr)}`)
    fs.rmSync(envPath(d), { force: true })
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

export function realDeps(o: {
  homedir: string
  agentDir: string
  configDir: string
  pathEnv: string
  names?: HindsightNames
  apiBasePort?: number
  uiBasePort?: number
}): HindsightDeps {
  const env = { ...process.env, PATH: dockerPath(o.pathEnv, o.homedir) }
  return {
    docker: (args, timeoutMs = 60_000) =>
      new Promise((resolve) => {
        execFile(
          'docker',
          args,
          { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (!err) return resolve({ code: 0, stdout, stderr })
            const e = err as NodeJS.ErrnoException & { code?: number | string }
            if (e.code === 'ENOENT')
              return resolve({ code: 127, stdout: '', stderr: 'docker not found', missing: true })
            resolve({
              code: typeof e.code === 'number' ? e.code : 1,
              stdout,
              stderr: stderr || e.message,
            })
          },
        )
      }),
    http: async (method, url, body) => {
      try {
        const res = await fetch(url, {
          method,
          signal: AbortSignal.timeout(10_000),
          ...(body !== undefined
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        })
        return { status: res.status }
      } catch {
        return { status: 0 }
      }
    },
    portFree: (port) =>
      new Promise((resolve) => {
        const s = net.createServer()
        s.once('error', () => resolve(false))
        s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    homedir: o.homedir,
    agentDir: o.agentDir,
    configDir: o.configDir,
    names: o.names ?? DEFAULT_NAMES,
    apiBasePort: o.apiBasePort ?? HINDSIGHT_API_BASE_PORT,
    uiBasePort: o.uiBasePort ?? HINDSIGHT_UI_BASE_PORT,
    healthTimeoutMs: 180_000,
  }
}
