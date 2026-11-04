import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HindsightDeps, HindsightProgress } from './hindsight'
import {
  HindsightError,
  firstFreePort,
  formatBytes,
  lastLine,
  readText,
  writeAtomic,
} from './hindsight-util'

/**
 * Hindsight without Docker: a private Python 3.12 and venv (via uv) under Relay's own folder,
 * `pip install hindsight-api` (the full package: local embedding and reranker models, embedded
 * Postgres "pg0"), and a LaunchAgent that keeps it running on 127.0.0.1. Nothing is installed
 * outside `<support>/hindsight` and `~/Library/LaunchAgents/<label>.plist`, so removing both
 * leaves no trace. Measured on Apple Silicon: about 2.5 GB to download (2.0 GB of wheels, 70 MB
 * Python, 390 MB models on first start), about 1 GB of memory while running.
 */

export const NATIVE_LABEL = 'ai.relay.hindsight'
export const NATIVE_API_BASE_PORT = 18888
/** Sizes measured on an Apple Silicon Mac; they only scale the progress bar. */
export const EXPECTED_VENV_BYTES = 2_100_000_000
export const EXPECTED_MODEL_BYTES = 390_000_000
export const EXPECTED_DOWNLOAD_NOTE = 'about 2.5 GB'
const PYTHON_VERSION = '3.12'
const WORKER_ID = 'hindsight-relay'

export const NATIVE_UNSUPPORTED =
  'The local memory models need an Apple Silicon Mac. This Mac has an Intel processor.'

export interface NativePaths {
  dir: string
  uvDir: string
  uv: string
  python: string
  venv: string
  venvPython: string
  api: string
  data: string
  pg0: string
  hf: string
  env: string
  run: string
  log: string
  state: string
  plist: string
  mlxServer: string
  llmRun: string
  llmLog: string
  llmPlist: string
}

export function nativePaths(
  d: Pick<HindsightDeps, 'nativeDir' | 'launchAgentsDir' | 'label'>,
): NativePaths {
  const dir = d.nativeDir
  const venv = path.join(dir, 'venv')
  const data = path.join(dir, 'data')
  return {
    dir,
    uvDir: path.join(dir, 'uv'),
    uv: path.join(dir, 'uv', 'uv'),
    python: path.join(dir, 'python'),
    venv,
    venvPython: path.join(venv, 'bin', 'python'),
    api: path.join(venv, 'bin', 'hindsight-api'),
    mlxServer: path.join(venv, 'bin', 'mlx_lm.server'),
    data,
    pg0: path.join(data, 'pg0'),
    hf: path.join(data, 'hf'),
    env: path.join(dir, 'hindsight.env'),
    run: path.join(dir, 'run.sh'),
    log: path.join(dir, 'logs', 'hindsight.log'),
    llmRun: path.join(dir, 'llm-run.sh'),
    llmLog: path.join(dir, 'logs', 'model.log'),
    state: path.join(dir, 'install.json'),
    plist: path.join(d.launchAgentsDir, `${d.label}.plist`),
    llmPlist: path.join(d.launchAgentsDir, `${d.label}.llm.plist`),
  }
}

// ---- generated files ------------------------------------------------------------------------

/** POSIX single-quote a path for run.sh. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The script the LaunchAgent runs: private LLM settings first, then the fixed, loopback-only ones. */
export function runScript(p: NativePaths, port: number): string {
  return [
    '#!/bin/sh',
    '# Written by Relay. Reinstalling from Settings regenerates it.',
    'set -a',
    `[ -f ${sq(p.env)} ] && . ${sq(p.env)}`,
    `PG0_HOME=${sq(p.pg0)}`,
    `PG0_INSTALLATION_DIR=${sq(path.join(p.pg0, 'install'))}`,
    `HF_HOME=${sq(p.hf)}`,
    'HINDSIGHT_API_HOST=127.0.0.1',
    `HINDSIGHT_API_PORT=${port}`,
    `HINDSIGHT_API_WORKER_ID=${WORKER_ID}`,
    'HINDSIGHT_API_DATABASE_URL=pg0://relay-hindsight',
    'set +a',
    `exec ${sq(p.api)}`,
    '',
  ].join('\n')
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function launchAgentPlist(label: string, script: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>${xml(script)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

/** The environment for every uv call: everything it fetches lands in our folder, nothing in $HOME. */
function uvEnv(p: NativePaths): Record<string, string> {
  return {
    UV_PYTHON_INSTALL_DIR: p.python,
    UV_PYTHON_BIN_DIR: path.join(p.uvDir, 'bin'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PYTHON_DOWNLOADS: 'automatic',
    UV_NO_CACHE: '1',
    UV_NO_CONFIG: '1',
  }
}

// ---- what is installed ----------------------------------------------------------------------

/** The installed hindsight-api version, read from the venv's dist-info (null when not installed). */
export function installedVersion(p: NativePaths): string | null {
  try {
    const lib = path.join(p.venv, 'lib')
    for (const py of fs.readdirSync(lib)) {
      const site = path.join(lib, py, 'site-packages')
      if (!fs.existsSync(site)) continue
      for (const e of fs.readdirSync(site)) {
        const m = /^hindsight_api-(.+)\.dist-info$/.exec(e)
        if (m) return m[1] ?? null
      }
    }
  } catch {
    /* no venv yet */
  }
  return null
}

export function readPort(p: NativePaths): number | null {
  try {
    const j = JSON.parse(readText(p.state) ?? '') as { port?: unknown }
    return typeof j.port === 'number' && Number.isInteger(j.port) ? j.port : null
  } catch {
    return null
  }
}

/** The model server Relay set up for Hindsight, from install.json (null when there is none). */
export function readLocal(p: NativePaths): { model: string; port: number } | null {
  try {
    const j = JSON.parse(readText(p.state) ?? '') as { llm?: { model?: unknown; port?: unknown } }
    const { model, port } = j.llm ?? {}
    return typeof model === 'string' && typeof port === 'number' ? { model, port } : null
  } catch {
    return null
  }
}

// ---- the model on this Mac -------------------------------------------------------------------

export interface LocalModel {
  /** Hugging Face repo that `mlx_lm.server` loads. */
  repo: string
  downloadBytes: number
  /** Memory it holds while running. */
  ramBytes: number
}

const GIB = 1024 ** 3

/**
 * The model Relay can run for Hindsight on this Mac, by installed memory. Hindsight's reading
 * (fact extraction as strict JSON) needs a capable model: below 32 GB nothing is offered, because
 * the small models that fit make poor memories and would also starve the Mac of memory.
 */
export function localModelFor(ramBytes: number): LocalModel | null {
  if (ramBytes < 32 * GIB) return null
  return {
    repo: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
    downloadBytes: 17_200_000_000,
    ramBytes: 18_000_000_000,
  }
}

/** The LLM settings that point Hindsight at the model server (an OpenAI-compatible endpoint). */
export function localLlmEnv(local: { model: string; port: number }): string {
  return [
    'HINDSIGHT_API_LLM_PROVIDER=openai',
    `HINDSIGHT_API_LLM_BASE_URL=http://127.0.0.1:${local.port}/v1`,
    'HINDSIGHT_API_LLM_API_KEY=local',
    `HINDSIGHT_API_LLM_MODEL=${local.model}`,
    // One local model serves one request at a time well; more only queue up and time out.
    'HINDSIGHT_API_LLM_MAX_CONCURRENT=1',
    '',
  ].join('\n')
}

/** The script that runs the model server: weights cached under our folder, loopback only. */
export function llmRunScript(p: NativePaths, local: { model: string; port: number }): string {
  return [
    '#!/bin/sh',
    '# Written by Relay. Reinstalling from Settings regenerates it.',
    `HF_HOME=${sq(p.hf)}`,
    'export HF_HOME',
    `exec ${sq(p.mlxServer)} --model ${sq(local.model)} --host 127.0.0.1 --port ${local.port}`,
    '',
  ].join('\n')
}

export interface NativeInfo {
  installed: boolean
  /** launchd has the agent loaded and its process is running. */
  running: boolean
  apiPort: number | null
  version: string | null
  /** The model Relay runs on this Mac for Hindsight, when it was set up that way. */
  local: { model: string; port: number } | null
  localRunning: boolean
}

const LAUNCHCTL = '/bin/launchctl'
const domain = (d: HindsightDeps): string => `gui/${d.uid}`
export const llmLabel = (d: Pick<HindsightDeps, 'label'>): string => `${d.label}.llm`

async function isRunning(d: HindsightDeps, label: string): Promise<boolean> {
  const r = await d.exec(LAUNCHCTL, ['print', `${domain(d)}/${label}`], { timeoutMs: 15_000 })
  return r.code === 0 && /^\s*state = running$/m.test(r.stdout)
}

export async function nativeInfo(d: HindsightDeps): Promise<NativeInfo> {
  const p = nativePaths(d)
  const version = installedVersion(p)
  if (version === null) {
    return {
      installed: false,
      running: false,
      apiPort: null,
      version: null,
      local: null,
      localRunning: false,
    }
  }
  const local = readLocal(p)
  return {
    installed: true,
    running: await isRunning(d, d.label),
    apiPort: readPort(p),
    version,
    local,
    localRunning: local !== null && (await isRunning(d, llmLabel(d))),
  }
}

// ---- install --------------------------------------------------------------------------------

/** Runs `work` while reporting how many bytes `dir` has grown by, every 1.5 s. */
async function withGrowth<T>(
  d: HindsightDeps,
  work: Promise<T>,
  dir: string,
  onGrowth: (bytes: number) => void,
): Promise<T> {
  const base = await d.dirSize(dir)
  let done = false
  void (async () => {
    while (!done) {
      await d.sleep(1500)
      if (done) return
      onGrowth(Math.max(0, (await d.dirSize(dir)) - base))
    }
  })()
  try {
    return await work
  } finally {
    done = true
  }
}

async function findUv(d: HindsightDeps, p: NativePaths): Promise<string | null> {
  for (const c of [p.uv, ...d.uvCandidates]) {
    if (!fs.existsSync(c)) continue
    if ((await d.exec(c, ['--version'], { timeoutMs: 15_000 })).code === 0) return c
  }
  return null
}

async function downloadUv(d: HindsightDeps, p: NativePaths): Promise<string> {
  const triple = d.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  const url = `https://github.com/astral-sh/uv/releases/latest/download/uv-${triple}.tar.gz`
  fs.mkdirSync(p.uvDir, { recursive: true })
  const tgz = path.join(p.uvDir, 'uv.tar.gz')
  try {
    await d.download(url, tgz)
  } catch (e) {
    throw new HindsightError(
      `Downloading uv failed: ${e instanceof Error ? e.message : String(e)}. Check your internet connection and try again.`,
    )
  }
  const x = await d.exec('/usr/bin/tar', ['-xzf', tgz, '-C', p.uvDir, '--strip-components=1'], {
    timeoutMs: 60_000,
  })
  fs.rmSync(tgz, { force: true })
  if (x.code !== 0) throw new HindsightError(`Unpacking uv failed: ${lastLine(x.stderr)}`)
  fs.chmodSync(p.uv, 0o755)
  return p.uv
}

/** Stops and unloads an agent. Safe when it is not loaded. */
async function unload(d: HindsightDeps, label: string): Promise<void> {
  await d.exec(LAUNCHCTL, ['bootout', `${domain(d)}/${label}`], { timeoutMs: 30_000 })
}

/** bootout returns before the old process is gone, so a bootstrap straight after can be refused. */
async function load(d: HindsightDeps, plist: string, label: string): Promise<void> {
  await unload(d, label)
  let r = await d.exec(LAUNCHCTL, ['bootstrap', domain(d), plist], { timeoutMs: 30_000 })
  for (let i = 0; r.code !== 0 && i < 8; i++) {
    await d.sleep(2000)
    r = await d.exec(LAUNCHCTL, ['bootstrap', domain(d), plist], { timeoutMs: 30_000 })
  }
  if (r.code !== 0) {
    throw new HindsightError(`macOS would not start the Hindsight service: ${lastLine(r.stderr)}`)
  }
}

async function waitHealthy(
  d: HindsightDeps,
  p: NativePaths,
  apiUrl: string,
  progress: HindsightProgress,
): Promise<void> {
  const deadline = Date.now() + d.healthTimeoutMs
  while (Date.now() < deadline) {
    if ((await d.http('GET', `${apiUrl}/health`)).status === 200) return
    const models = await d.dirSize(p.hf)
    progress(
      Math.min(88, 72 + Math.round(16 * Math.min(1, models / EXPECTED_MODEL_BYTES))),
      models < EXPECTED_MODEL_BYTES * 0.97
        ? `First start: downloading the language models, ${formatBytes(models)} of about ${formatBytes(EXPECTED_MODEL_BYTES)}`
        : 'Starting the memory database and loading the models',
    )
    await d.sleep(2000)
  }
  throw new HindsightError(`Hindsight did not answer at ${apiUrl}. Its log is at ${p.log}.`)
}

/**
 * Installs (or finishes installing, or restarts) the native service and waits until it answers.
 * Every step checks what is already there, so a retry resumes. Returns its API url.
 */
export async function installNative(
  d: HindsightDeps,
  llmEnv: { text: string | null; legacy: string | null },
  localPlan: LocalModel | null,
  progress: HindsightProgress,
): Promise<string> {
  if (d.arch !== 'arm64') throw new HindsightError(NATIVE_UNSUPPORTED)
  const p = nativePaths(d)
  fs.mkdirSync(p.dir, { recursive: true })

  progress(3, 'Looking for uv, the Python installer')
  let uv = await findUv(d, p)
  if (!uv) {
    progress(5, 'Downloading uv (about 20 MB)')
    uv = await downloadUv(d, p)
  }
  const env = uvEnv(p)

  if (!fs.existsSync(p.venvPython)) {
    progress(8, 'Downloading a private Python 3.12 (about 70 MB)')
    const venv = await withGrowth(
      d,
      d.exec(uv, ['venv', '--python', PYTHON_VERSION, p.venv], { env, timeoutMs: 20 * 60_000 }),
      p.dir,
      (b) => progress(10, `Downloading a private Python 3.12: ${formatBytes(b)} of about 70 MB`),
    )
    if (venv.code !== 0) {
      throw new HindsightError(`Could not set up Python: ${lastLine(venv.stderr)}`)
    }
  }

  if (installedVersion(p) === null) {
    progress(15, `Downloading Hindsight (${EXPECTED_DOWNLOAD_NOTE} in total, a few minutes)`)
    const pip = await withGrowth(
      d,
      d.exec(uv, ['pip', 'install', '--python', p.venvPython, 'hindsight-api'], {
        env,
        timeoutMs: 45 * 60_000,
      }),
      p.dir,
      (b) =>
        progress(
          15 + Math.round(50 * Math.min(1, b / EXPECTED_VENV_BYTES)),
          `Installing Hindsight: ${formatBytes(b)} of about ${formatBytes(EXPECTED_VENV_BYTES)}`,
        ),
    )
    if (pip.code !== 0) {
      throw new HindsightError(`Installing Hindsight failed: ${lastLine(pip.stderr)}`)
    }
  }

  progress(66, 'Writing the service settings')
  const port = await pickPort(d, p)
  // A re-run without asking for the model again keeps the one that is already set up.
  const local = localPlan ? { model: localPlan.repo, port: await pickLlmPort(d, p) } : readLocal(p)
  if (localPlan && local) writeAtomic(p.env, localLlmEnv(local), 0o600)
  else if (llmEnv.text !== null) writeAtomic(p.env, llmEnv.text, 0o600)
  else if (!fs.existsSync(p.env) && llmEnv.legacy !== null) writeAtomic(p.env, llmEnv.legacy, 0o600)
  fs.mkdirSync(p.pg0, { recursive: true })
  fs.mkdirSync(p.hf, { recursive: true })
  await startAll(d, p, port, local, progress, localPlan?.downloadBytes)
  return `http://127.0.0.1:${port}`
}

/**
 * Writes the run scripts, plists and state, then starts the model server (when there is one) and
 * waits for it, then Hindsight and waits for it. The model comes first: Hindsight checks its LLM
 * on start.
 */
async function startAll(
  d: HindsightDeps,
  p: NativePaths,
  port: number,
  local: { model: string; port: number } | null,
  progress: HindsightProgress,
  localDownloadBytes?: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(p.log), { recursive: true })
  writeAtomic(p.run, runScript(p, port), 0o755)
  writeAtomic(p.state, JSON.stringify({ port, ...(local ? { llm: local } : {}) }) + '\n')
  writeAtomic(p.plist, launchAgentPlist(d.label, p.run, p.log))
  if (local) {
    writeAtomic(p.llmRun, llmRunScript(p, local), 0o755)
    writeAtomic(p.llmPlist, launchAgentPlist(llmLabel(d), p.llmRun, p.llmLog))
    progress(66, 'Starting the model on this Mac')
    await load(d, p.llmPlist, llmLabel(d))
    await waitLocal(d, p, local, localDownloadBytes ?? 0, progress)
  }
  progress(72, 'Starting the Hindsight service')
  await load(d, p.plist, d.label)
  await waitHealthy(d, p, `http://127.0.0.1:${port}`, progress)
}

/** Waits for the model server, showing the download while it fetches the weights. */
async function waitLocal(
  d: HindsightDeps,
  p: NativePaths,
  local: { model: string; port: number },
  expectedBytes: number,
  progress: HindsightProgress,
): Promise<void> {
  const deadline = Date.now() + d.healthTimeoutMs * 4
  while (Date.now() < deadline) {
    if ((await d.http('GET', `http://127.0.0.1:${local.port}/v1/models`)).status === 200) return
    const bytes = await d.dirSize(p.hf)
    progress(
      66 + Math.round(5 * Math.min(1, expectedBytes > 0 ? bytes / expectedBytes : 0)),
      expectedBytes > 0 && bytes < expectedBytes * 0.97
        ? `Downloading the model: ${formatBytes(bytes)} of about ${formatBytes(expectedBytes)}`
        : 'Loading the model into memory',
    )
    await d.sleep(2000)
  }
  throw new HindsightError(`The model on this Mac did not start. Its log is at ${p.llmLog}.`)
}

/** A free port for the model server, kept from an earlier install when nothing else took it. */
async function pickLlmPort(d: HindsightDeps, p: NativePaths): Promise<number> {
  const old = readLocal(p)?.port
  if (old !== undefined && ((await nativeInfo(d)).localRunning || (await d.portFree(old))))
    return old
  return firstFreePort(d.apiBasePort + 100, d.portFree)
}

/** Keeps the port from an earlier install when nothing else took it; else the first free one. */
async function pickPort(d: HindsightDeps, p: NativePaths): Promise<number> {
  const old = readPort(p)
  if (old !== null) {
    const info = await nativeInfo(d)
    if (info.running || (await d.portFree(old))) return old
  }
  return firstFreePort(d.apiBasePort, d.portFree)
}

/** `uv pip install -U`, then a restart so the new code is the code that runs. */
export async function updateNative(
  d: HindsightDeps,
  progress: HindsightProgress,
): Promise<{ from: string; to: string }> {
  const p = nativePaths(d)
  const from = installedVersion(p)
  const port = readPort(p)
  if (from === null || port === null) {
    throw new HindsightError('Hindsight is not installed yet. Press Set up first.')
  }
  progress(5, 'Looking for uv')
  const uv = await findUv(d, p)
  if (!uv) throw new HindsightError('The private uv is missing. Remove and set up again.')
  progress(15, `Checking for a newer Hindsight (now ${from})`)
  const pip = await withGrowth(
    d,
    d.exec(uv, ['pip', 'install', '--upgrade', '--python', p.venvPython, 'hindsight-api'], {
      env: uvEnv(p),
      timeoutMs: 45 * 60_000,
    }),
    p.dir,
    (b) => progress(40, `Downloading: ${formatBytes(b)}`),
  )
  if (pip.code !== 0) throw new HindsightError(`Updating failed: ${lastLine(pip.stderr)}`)
  const to = installedVersion(p) ?? from
  progress(70, 'Restarting Hindsight')
  await startAll(d, p, port, readLocal(p), progress)
  return { from, to }
}

/**
 * `disable` unloads the agents and deletes their plists (so they do not come back at login); the
 * venv, models and memories stay. `remove` deletes our whole folder as well.
 */
export async function stopNative(d: HindsightDeps, action: 'disable' | 'remove'): Promise<void> {
  const p = nativePaths(d)
  await unload(d, d.label)
  await unload(d, llmLabel(d))
  fs.rmSync(p.plist, { force: true })
  fs.rmSync(p.llmPlist, { force: true })
  if (action === 'remove') fs.rmSync(p.dir, { recursive: true, force: true })
}

/** Starts it again (after a crash, a failed model, or a Turn off): same files, same port. */
export async function restartNative(d: HindsightDeps, progress: HindsightProgress): Promise<void> {
  const p = nativePaths(d)
  const port = readPort(p)
  if (installedVersion(p) === null || port === null) {
    throw new HindsightError('Hindsight is not installed yet. Press Set up first.')
  }
  progress(10, 'Restarting Hindsight')
  await startAll(d, p, port, readLocal(p), progress)
}
