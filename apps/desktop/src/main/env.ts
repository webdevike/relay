import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { relayConfigDir } from './relay/device'

export interface Env {
  evaRoot: string
  ompBin: string
  /**
   * EVAOS_OMP_PROFILES_DIR: omp profiles, one folder per profile (the usage meter's accounts).
   * Live default `~/.omp/profiles`; otherwise the fixture profiles.
   */
  ompProfilesDir: string
  configDir: string
  /** Live default only: the pre-rename folder to move into configDir once. */
  legacyConfigDir: string | null
  sessionsDir: string
  arcExportCmd: string[] | null
  live: boolean
  e2e: boolean
  /** EVAOS_HIDDEN_WINDOW=1: transparent, click-through, never-active window (all test launches). */
  hiddenWindow: boolean
  noMotion: boolean
  repoRoot: string
  habitGateBin: string
  jobRunBin: string
  /** EVAOS_NOW raw ISO 8601 string; null when unset. */
  now: string | null
  habitPhotosDir: string
  /** EVAOS_AGENT_DIR: omp agent dir (session-pins.json, blobs). */
  agentDir: string
  /** EVAOS_CLAUDE_BRIDGE_BIN: Claude harness bridge script. */
  claudeBridgeBin: string
  /** EVAOS_CLAUDE_BIN: claude CLI. */
  claudeBin: string
  /**
   * EVAOS_HERDR_BIN: herdr, which new omp chats start in (like native EvaOS). Live default: herdr
   * on PATH or in the usual install folders; null when there is none, and in dev and tests unless
   * set, so a new chat starts a local omp child.
   */
  herdrBin: string | null
  /**
   * Relay's config folder (serve.json, devices.json) to connect to. EVAOS_RELAY_DIR wins (e2e
   * points it at a fake host); live default `$XDG_CONFIG_HOME/relay` or `~/.config/relay`; null in
   * dev and tests, where Relay is never connected.
   */
  relayDir: string | null
  /**
   * Chrome DevTools Protocol port on 127.0.0.1 so Eva can drive the running app with Playwright.
   * Live default 9339 (Arc 9222, eva-browser 9292, Slack 9333, Chrome 9444); EVAOS_CDP_PORT
   * overrides, 0 turns it off; null in tests.
   */
  cdpPort: number | null
  /**
   * Canvas boards: shared content, not app config. EVAOS_CANVAS_DIR wins; live uses the folder
   * native EvaOS and the canvas skill use; otherwise `<configDir>/canvases`.
   */
  canvasDir: string
  /** Non-live default only: fixture boards copied into canvasDir when it does not exist yet. */
  canvasSeedDir: string | null
  /** Live only: native EvaOS pins, read once when Relay has no canvas pins of its own. */
  nativeCanvasPins: string | null
}

export interface ResolveEnvInput {
  env: NodeJS.ProcessEnv
  isPackaged: boolean
  repoRoot: string
  homedir: string
  tmpdir: string
  pid: number
}

const DEFAULT_ARC_CMD = ['bun', '.omp/tools/arc-cookies.ts', '.omp/tools/lib/evaos-arc-sites.txt']

function real(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** Mirrors the Rust `binary()` lookup: PATH, then the usual install locations; null when absent. */
function findBin(name: string, env: NodeJS.ProcessEnv, homedir: string): string | null {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  dirs.push(path.join(homedir, '.local/bin'), path.join(homedir, '.bun/bin'), '/opt/homebrew/bin')
  for (const d of dirs) {
    const candidate = path.join(d, name)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

function findClaude(env: NodeJS.ProcessEnv, homedir: string): string {
  for (const d of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(d, 'claude')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return path.join(homedir, '.local/bin/claude')
}

function parseArcCmd(raw: string | undefined): string[] | null {
  if (!raw) return DEFAULT_ARC_CMD
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length > 0) {
      return parsed as string[]
    }
  } catch {
    /* fall through */
  }
  throw new Error('EVAOS_ARC_EXPORT_CMD must be a JSON array of strings')
}

export function resolveEnv(input: ResolveEnvInput): Env {
  const { env, isPackaged, repoRoot, homedir, tmpdir, pid } = input
  const live = isPackaged || env.EVAOS_LIVE === '1'
  const realRoot = path.join(homedir, 'Eva')

  const evaRoot = env.EVAOS_EVA_ROOT
    ? env.EVAOS_EVA_ROOT
    : live
      ? realRoot
      : path.join(repoRoot, 'fixtures/eva-root')
  if (!live && real(evaRoot) === real(realRoot)) {
    throw new Error(
      `Refusing to use the real Eva root (${realRoot}) in dev or test. Set EVAOS_LIVE=1 to opt in.`,
    )
  }

  const ompBin = env.EVAOS_OMP_BIN
    ? env.EVAOS_OMP_BIN
    : live
      ? (findBin('omp', env, homedir) ?? 'omp')
      : path.join(repoRoot, 'fixtures/fake-omp/fake-omp.mjs')

  const ompProfilesDir = env.EVAOS_OMP_PROFILES_DIR
    ? env.EVAOS_OMP_PROFILES_DIR
    : live
      ? path.join(homedir, '.omp/profiles')
      : path.join(repoRoot, 'fixtures/omp-profiles')

  const herdrBin = env.EVAOS_HERDR_BIN
    ? env.EVAOS_HERDR_BIN
    : live
      ? findBin('herdr', env, homedir)
      : null

  const e2e = env.EVAOS_E2E === '1'
  const relayDir = env.EVAOS_RELAY_DIR
    ? env.EVAOS_RELAY_DIR
    : live && !e2e
      ? relayConfigDir(env, homedir)
      : null

  const sessionsDir = env.EVAOS_SESSIONS_DIR
    ? env.EVAOS_SESSIONS_DIR
    : live
      ? path.join(env.PI_CODING_AGENT_DIR || path.join(homedir, '.omp/agent'), 'sessions/-Eva')
      : path.join(repoRoot, 'fixtures/agent/sessions/-fixture')

  // The app is "Relay"; its folder is "Relay Desktop" because Relay Host already owns "Relay".
  const supportDir = path.join(homedir, 'Library/Application Support')
  const configDir = env.EVAOS_CONFIG_DIR
    ? env.EVAOS_CONFIG_DIR
    : live
      ? path.join(supportDir, 'Relay Desktop')
      : path.join(tmpdir, `evaos-electron-dev-${pid}`)
  // Builds named "EvaOS Electron" kept their state here; moved once into configDir at launch.
  const legacyConfigDir =
    live && !env.EVAOS_CONFIG_DIR ? path.join(supportDir, 'EvaOS Electron') : null

  const cdpPort = parseCdpPort(env.EVAOS_CDP_PORT, live && env.EVAOS_E2E !== '1')

  // Native EvaOS keeps boards under its config dir; the canvas skill writes them there.
  const nativeDir = path.join(supportDir, 'EvaOS')
  const nativeCanvasDir = path.join(nativeDir, 'canvases')
  const canvasDir = env.EVAOS_CANVAS_DIR
    ? env.EVAOS_CANVAS_DIR
    : live
      ? nativeCanvasDir
      : path.join(configDir, 'canvases')
  if (!live && real(canvasDir) === real(nativeCanvasDir)) {
    throw new Error(
      `Refusing to use the real canvas folder (${nativeCanvasDir}) in dev or test. Set EVAOS_LIVE=1 to opt in.`,
    )
  }
  const canvasSeedDir =
    !live && !env.EVAOS_CANVAS_DIR ? path.join(repoRoot, 'fixtures/canvases') : null
  const nativeCanvasPins = live ? path.join(nativeDir, 'canvas.json') : null

  const habitGateBin = env.EVAOS_HABIT_GATE_BIN
    ? env.EVAOS_HABIT_GATE_BIN
    : live
      ? path.join(evaRoot, '.omp/tools/habit-gate.ts')
      : path.join(repoRoot, 'fixtures/fake-gate/fake-gate.mjs')

  const jobRunBin = env.EVAOS_JOB_RUN_BIN
    ? env.EVAOS_JOB_RUN_BIN
    : live
      ? path.join(evaRoot, '.omp/tools/job-run.ts')
      : path.join(repoRoot, 'fixtures/fake-job-run/fake-job-run.mjs')

  const habitPhotosDir = env.EVAOS_HABIT_PHOTOS_DIR
    ? env.EVAOS_HABIT_PHOTOS_DIR
    : live
      ? path.join(homedir, '.config/eva/habit-photos')
      : path.join(tmpdir, 'evaos-fake-gate/photos')

  const agentDir = env.EVAOS_AGENT_DIR
    ? env.EVAOS_AGENT_DIR
    : live
      ? env.PI_CODING_AGENT_DIR || path.join(homedir, '.omp/agent')
      : path.join(repoRoot, 'fixtures/agent')

  const fakeBridge = path.join(repoRoot, 'fixtures/fake-claude-bridge/fake-bridge.mjs')
  const claudeBridgeBin = env.EVAOS_CLAUDE_BRIDGE_BIN
    ? env.EVAOS_CLAUDE_BRIDGE_BIN
    : live
      ? path.join(evaRoot, '.claude/bridge/session.ts')
      : fakeBridge
  const claudeBin = env.EVAOS_CLAUDE_BIN
    ? env.EVAOS_CLAUDE_BIN
    : live
      ? findClaude(env, homedir)
      : fakeBridge

  const now = env.EVAOS_NOW ? env.EVAOS_NOW : null
  if (now !== null && !Number.isFinite(Date.parse(now))) {
    throw new Error('EVAOS_NOW must be an ISO 8601 date-time')
  }

  return {
    habitGateBin,
    jobRunBin,
    now,
    habitPhotosDir,
    agentDir,
    claudeBridgeBin,
    claudeBin,
    herdrBin,
    relayDir,
    evaRoot,
    ompBin,
    ompProfilesDir,
    configDir,
    legacyConfigDir,
    sessionsDir,
    arcExportCmd: parseArcCmd(env.EVAOS_ARC_EXPORT_CMD),
    live,
    e2e,
    hiddenWindow: env.EVAOS_HIDDEN_WINDOW === '1',
    noMotion: env.EVAOS_NO_MOTION === '1',
    canvasDir,
    canvasSeedDir,
    nativeCanvasPins,
    repoRoot,
    cdpPort,
  }
}

function parseCdpPort(raw: string | undefined, liveDefault: boolean): number | null {
  if (raw === undefined || raw === '') return liveDefault ? 9339 : null
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`EVAOS_CDP_PORT must be a port number, got ${raw}`)
  }
  return port === 0 ? null : port
}

export function loadEnv(app: { isPackaged: boolean; getAppPath(): string }): Env {
  return resolveEnv({
    env: process.env,
    isPackaged: app.isPackaged,
    repoRoot: path.resolve(app.getAppPath(), '../..'),
    homedir: os.homedir(),
    tmpdir: os.tmpdir(),
    pid: process.pid,
  })
}
