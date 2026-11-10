import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { whichIn } from './bins'

/**
 * The outward-action guard every seat runs under, whatever its harness.
 *
 * A seat may do anything inside the room, but an outward action (git push, gh writes, deploys,
 * publishing, sending mail or messages, deleting or writing outside the room) waits for Isaac:
 * the guard writes `<asksDir>/<askId>.json` = {id, seatId, action, at} and polls for
 * `<asksDir>/<askId>.answer` (`allow` or `deny`) up to ten minutes, then denies. The engine turns
 * the ask file into a room button and RoomsService.answer writes the answer file.
 *
 * Two layers, one script (`guard.cjs`, run with Electron as node so the packaged app needs no
 * node of its own):
 * - PATH shims for git, gh, the deploy CLIs, the package managers and the mail tools. Every
 *   harness's shell sees them first on PATH; a blocked call asks, then runs the real binary or
 *   fails.
 * - A PreToolUse hook (Claude Code `--settings`, Codex `-c hooks...`) that reads the tool call,
 *   checks every command in a shell line and every written path, and asks before it runs. It
 *   covers shells that rebuild PATH from the login profile. An allowed hook ask leaves a grant
 *   the shim then honours, so one action never asks twice.
 */

export interface GuardOptions {
  workdir: string
  asksDir: string
  seatId: string
  /** The seat's PATH without the shims (real binaries are resolved from it). */
  path: string
  /** Where the guard's files go; a fresh temp dir by default. */
  dir?: string
  /** Node to run the guard with: the app itself as node by default. */
  node?: string
  /** How long an ask waits for an answer before it denies. */
  waitMs?: number
  pollMs?: number
}

export interface GuardInstall {
  dir: string
  /** The shim dir, first on the seat's PATH. */
  binDir: string
  /** Env for the seat process: PATH with the shims first, and Claude Code's per-command env file. */
  env: Record<string, string>
  /** The shell command a PreToolUse hook runs. */
  hookCommand: string
  /** Claude Code `--settings` JSON. */
  claudeSettings: string
  /** Codex `-c` overrides (and the trust bypass) that install the same hook for one run. */
  codexArgs: string[]
  /** Removes the guard's files. */
  dispose(): void
}

/** Ten minutes, then the action is denied. */
export const ASK_WAIT_MS = 10 * 60_000
/** Hook timeout (seconds): the ask wait plus slack, so the harness never kills a waiting hook. */
const HOOK_TIMEOUT_S = ASK_WAIT_MS / 1000 + 60

/**
 * The binaries that get a shim, each with an optional shell `case` pattern: calls whose args do
 * not match skip the guard and exec the real binary at once (git and the package managers run
 * all the time; their outward subcommands are rare).
 */
const SHIMS: Record<string, string | null> = {
  git: '*push*|*send-email*',
  gh: null,
  wrangler: null,
  vercel: null,
  fly: null,
  flyctl: null,
  netlify: null,
  firebase: null,
  npm: '*publish*|*run*|*exec*',
  pnpm: '*publish*|*run*|*exec*|*dlx*',
  yarn: '*publish*|*run*|*dlx*',
  bun: '*publish*|*run*|*" x "*',
  npx: null,
  pnpx: null,
  bunx: null,
  sendmail: null,
  mail: null,
  mailx: null,
  msmtp: null,
  osascript: '*Mail*|*Messages*',
}

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The guard runtime, plain CommonJS so it runs in any node (and Electron as node).
 *   guard.cjs check <tool> <args...>   exit 0 to run it, 1 when Isaac said no
 *   guard.cjs hook                     PreToolUse hook: tool call JSON on stdin, decision on stdout
 */
const GUARD_SCRIPT = String.raw`'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))
const home = os.homedir()

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function real(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

const roots = [cfg.workdir, real(cfg.workdir)]
const scratch = [os.tmpdir(), real(os.tmpdir()), '/tmp', '/private/tmp', '/dev']
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : dir + '/')

/** True when a path (relative to cwd) is outside the room and outside scratch space. */
function outside(p, cwd) {
  if (typeof p !== 'string' || p === '') return false
  let q = p
  if (q === '~' || q.startsWith('~/')) q = home + q.slice(1)
  q = q.replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home)
  if (q.includes('$')) return false
  const abs = path.resolve(cwd, q)
  const both = [abs, real(abs), real(path.dirname(abs))]
  return !both.some((a) => roots.some((r) => inside(a, r)) || scratch.some((r) => inside(a, r)))
}

/** Index of the first positional arg, skipping flags (and the values of flags that take one). */
function positional(args, valueFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (valueFlags.includes(a)) {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    return i
  }
  return -1
}

const GH_WRITES = {
  pr: ['create', 'merge', 'comment', 'review', 'close', 'edit', 'ready', 'reopen'],
  issue: ['create', 'comment', 'close', 'edit', 'reopen', 'delete', 'transfer'],
  release: ['create', 'upload', 'delete', 'edit', 'delete-asset'],
  repo: ['create', 'delete', 'edit', 'fork', 'rename', 'archive'],
  gist: ['create', 'edit', 'delete'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  label: ['create', 'edit', 'delete'],
}
const DEPLOYERS = ['wrangler', 'vercel', 'fly', 'flyctl', 'netlify', 'firebase']
const PACKAGERS = ['npm', 'pnpm', 'yarn', 'bun']
const RUNNERS = ['npx', 'pnpx', 'bunx']
const DELETERS = ['rm', 'rmdir', 'unlink', 'trash', 'srm', 'shred']
const MAILERS = ['sendmail', 'mail', 'mailx', 'msmtp']
const RISKY_SCRIPT = /deploy|publish|release/i

/** What an argv would do outward, in plain words, or null when it stays in the room. */
function classify(argv, cwd) {
  const name = path.basename(argv[0] || '')
  const args = argv.slice(1)
  const line = argv.join(' ')
  if (name === 'git') {
    const s = args[positional(args, ['-C', '-c', '--git-dir', '--work-tree', '--namespace'])]
    if (s === 'push') return line
    if (s === 'send-email') return line + ' (sends mail)'
    return null
  }
  if (name === 'gh') {
    const i = positional(args, ['-R', '--repo'])
    const s = args[i]
    const rest = i < 0 ? [] : args.slice(i + 1)
    if (s === 'api') {
      let method = 'GET'
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j]
        if (a === '-X' || a === '--method') method = String(rest[j + 1] || '').toUpperCase()
        else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase()
        else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase()
        else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a) && method === 'GET')
          method = 'POST'
      }
      return method === 'GET' ? null : line
    }
    const verb = rest[positional(rest, ['-R', '--repo'])]
    return GH_WRITES[s] && GH_WRITES[s].includes(verb) ? line : null
  }
  if (DEPLOYERS.includes(name)) {
    if (name === 'vercel') {
      const s = args[positional(args, ['--scope', '--token', '-t', '--cwd'])]
      const deploys = s === undefined || ['deploy', 'promote', 'redeploy', 'rollback', 'alias'].includes(s)
      return deploys || args.includes('--prod') ? line + ' (deploys)' : null
    }
    return args.some((a) => a === 'deploy' || a === 'publish' || a === 'destroy' || a.endsWith(':deploy'))
      ? line + ' (deploys)'
      : null
  }
  if (PACKAGERS.includes(name) || RUNNERS.includes(name)) {
    if (args.includes('publish') || args.includes('unpublish')) return line + ' (publishes)'
    if (RUNNERS.includes(name)) {
      const i = positional(args, ['-p', '--package'])
      return i < 0 ? null : classify(args.slice(i), cwd)
    }
    const i = positional(args, ['--filter', '-F', '-C', '--dir', '--cwd', '-w', '--workspace'])
    const s = args[i]
    if (s === 'run' || s === 'run-script') {
      const script = args[i + 1 + Math.max(0, positional(args.slice(i + 1), []))]
      return script && RISKY_SCRIPT.test(script) ? line : null
    }
    if (s === 'exec' || s === 'dlx' || s === 'x') {
      const rest = args.slice(i + 1)
      const j = positional(rest, ['-p', '--package'])
      return j < 0 ? null : classify(rest.slice(j), cwd)
    }
    return null
  }
  if (MAILERS.includes(name)) return line + ' (sends mail)'
  if (name === 'osascript') {
    return /application\s+"?(Mail|Messages)/i.test(line) && /\bsend\b/i.test(line)
      ? line + ' (sends a message)'
      : null
  }
  if (DELETERS.includes(name)) {
    const out = args.filter((a) => !a.startsWith('-') && outside(a, cwd))
    return out.length > 0 ? name + ' ' + out.join(' ') + ' (outside the room)' : null
  }
  if (name === 'mv') {
    const out = args.filter((a) => !a.startsWith('-') && outside(a, cwd))
    return out.length > 0 ? 'mv ' + out.join(' ') + ' (outside the room)' : null
  }
  if (name === 'cp' || name === 'rsync' || name === 'ditto' || name === 'install' || name === 'ln') {
    const paths = args.filter((a) => !a.startsWith('-'))
    const dest = paths[paths.length - 1]
    return paths.length > 1 && outside(dest, cwd) ? 'write ' + dest + ' (outside the room)' : null
  }
  if (name === 'tee' || name === 'touch' || name === 'mkdir') {
    const out = args.filter((a) => !a.startsWith('-') && outside(a, cwd))
    return out.length > 0 ? 'write ' + out.join(' ') + ' (outside the room)' : null
  }
  return null
}

/**
 * A shell line split into simple commands (word lists). Quotes and escapes are honoured;
 * ; & | && || newlines, ( ) and $( ) and backticks all start a new command, so a command
 * inside a substitution is checked on its own. Redirection targets come back as
 * ['>', target] commands.
 */
function commands(src) {
  const out = []
  let words = []
  let word = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCmd = () => {
    endWord()
    if (words.length > 0) out.push(words)
    words = []
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      word = (word || '') + src.slice(i + 1, j < 0 ? src.length : j)
      i = j < 0 ? src.length : j
    } else if (c === '"') {
      let s = ''
      let j = i + 1
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && j + 1 < src.length) s += src[++j]
        else s += src[j]
      }
      word = (word || '') + s
      i = j
    } else if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') word = (word || '') + src[i + 1]
      i++
    } else if (c === '#' && word === null) {
      while (i < src.length && src[i] !== '\n') i++
      endCmd()
    } else if (c === '$' && src[i + 1] === '(') {
      endCmd()
      i++
    } else if (';&|()\n'.includes(c) || c === '\x60') {
      endCmd()
    } else if (c === '>' || c === '<') {
      endWord()
      while (src[i + 1] === '>' || src[i + 1] === '&' || src[i + 1] === '|') i++
      if (c === '>') words.push('>')
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word = (word || '') + c
    }
  }
  endCmd()
  // Redirections become their own ['>', target] commands; the rest of the words stay.
  const flat = []
  for (const w of out) {
    const rest = []
    for (let i = 0; i < w.length; i++) {
      if (w[i] === '>') {
        if (i + 1 < w.length) flat.push(['>', w[i + 1]])
        i++
      } else rest.push(w[i])
    }
    if (rest.length > 0) flat.push(rest)
  }
  return flat
}

const WRAPPERS = ['sudo', 'command', 'exec', 'nohup', 'time', 'nice', 'caffeinate', 'builtin', 'then', 'do', 'else', '!']

/** Every outward action in a shell line. */
function shellActions(src, cwd, depth) {
  const found = []
  for (let words of commands(src)) {
    if (words[0] === '>') {
      if (outside(words[1], cwd)) found.push('write ' + words[1] + ' (outside the room)')
      continue
    }
    for (;;) {
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1)
      const w = words[0]
      if (w === 'env') {
        words = words.slice(1)
        while (words.length > 0 && words[0].startsWith('-')) words = words.slice(1)
        continue
      }
      if (w === 'timeout') {
        words = words.slice(1)
        while (words.length > 0 && words[0].startsWith('-')) words = words.slice(1)
        words = words.slice(1)
        continue
      }
      if (w === 'xargs') {
        words = words.slice(1)
        while (words.length > 0 && words[0].startsWith('-')) words = words.slice(1)
        continue
      }
      if (WRAPPERS.includes(w)) {
        words = words.slice(1)
        continue
      }
      break
    }
    if (words.length === 0) continue
    const name = path.basename(words[0])
    const c = words.findIndex((a, i) => i > 0 && /^-[a-z]*c$/.test(a))
    if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name) && c > 0 && depth < 4) {
      found.push(...shellActions(words[c + 1] || '', cwd, depth + 1))
      continue
    }
    if (name === 'cd' && words[1]) {
      cwd = path.resolve(cwd, words[1].replace(/^~(?=\/|$)/, home))
      continue
    }
    const a = classify(words, cwd)
    if (a) found.push(a)
  }
  return found
}

/** Paths an apply_patch body touches. */
function patchPaths(body) {
  const out = []
  const re = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm
  let m
  while ((m = re.exec(body))) out.push(m[1].trim())
  return out
}

/** Outward actions in one PreToolUse call (Claude Code or Codex shapes). */
function toolActions(input) {
  const name = String(input.tool_name || '')
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : process.cwd()
  const found = []
  const cmd = ti.command !== undefined ? ti.command : ti.cmd
  if (typeof cmd === 'string' && /^\s*\*\*\* Begin Patch/.test(cmd)) {
    for (const p of patchPaths(cmd)) if (outside(p, cwd)) found.push('write ' + p + ' (outside the room)')
  } else if (typeof cmd === 'string') {
    found.push(...shellActions(cmd, cwd, 0))
  } else if (Array.isArray(cmd) && cmd.every((x) => typeof x === 'string')) {
    const c = cmd.findIndex((a, i) => i > 0 && /^-[a-z]*c$/.test(a))
    if (c > 0 && ['sh', 'bash', 'zsh'].includes(path.basename(cmd[0]))) found.push(...shellActions(cmd[c + 1] || '', cwd, 0))
    else {
      const a = classify(cmd, cwd)
      if (a) found.push(a)
    }
  }
  for (const k of ['input', 'patch']) {
    if (typeof ti[k] === 'string' && /\*\*\* Begin Patch/.test(ti[k])) {
      for (const p of patchPaths(ti[k])) if (outside(p, cwd)) found.push('write ' + p + ' (outside the room)')
    }
  }
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) {
    const p = ti.file_path || ti.notebook_path || ti.path
    if (outside(p, cwd)) found.push('write ' + p + ' (outside the room)')
  }
  return found
}

/** Asks Isaac and waits for the answer file; true only on an explicit allow. */
function ask(action) {
  const id = cfg.seatId + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  fs.mkdirSync(cfg.asksDir, { recursive: true })
  const tmp = path.join(cfg.asksDir, '.' + id + '.tmp')
  const body = { id: id, seatId: cfg.seatId, action: action, at: new Date().toISOString() }
  fs.writeFileSync(tmp, JSON.stringify(body) + '\n')
  fs.renameSync(tmp, path.join(cfg.asksDir, id + '.json'))
  const answer = path.join(cfg.asksDir, id + '.answer')
  const deadline = Date.now() + cfg.waitMs
  while (Date.now() < deadline) {
    try {
      return fs.readFileSync(answer, 'utf8').trim() === 'allow'
    } catch {
      sleep(cfg.pollMs)
    }
  }
  return false
}

const grants = path.join(__dirname, 'grants')
const kindOf = (action) => action.split(' ').slice(0, 2).join(' ')

/** Leaves a grant for the shim that will see this action next. */
function grant(action) {
  fs.mkdirSync(grants, { recursive: true })
  fs.writeFileSync(path.join(grants, Date.now() + '-' + Math.random().toString(36).slice(2, 6)), kindOf(action))
}

/** Takes a fresh grant of this kind, if the hook already asked. */
function takeGrant(action) {
  const kind = kindOf(action)
  let names = []
  try {
    names = fs.readdirSync(grants)
  } catch {
    return false
  }
  for (const n of names) {
    const f = path.join(grants, n)
    try {
      if (Date.now() - Number(n.split('-')[0]) > 120000) {
        fs.rmSync(f, { force: true })
        continue
      }
      if (fs.readFileSync(f, 'utf8') === kind) {
        fs.rmSync(f, { force: true })
        return true
      }
    } catch {}
  }
  return false
}

function denied(action) {
  return 'Isaac did not allow this: ' + action + '. Do not try it another way; keep working inside the room and say what you needed in your reply.'
}

const mode = process.argv[2]
if (mode === 'check') {
  const action = classify(process.argv.slice(3), process.cwd())
  if (!action || takeGrant(action) || ask(action)) process.exit(0)
  process.stderr.write('Relay: ' + denied(action) + '\n')
  process.exit(1)
} else if (mode === 'hook') {
  let raw = ''
  try {
    raw = fs.readFileSync(0, 'utf8')
  } catch {}
  let input = {}
  try {
    input = JSON.parse(raw)
  } catch {}
  for (const action of toolActions(input)) {
    if (ask(action)) {
      grant(action)
      continue
    }
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: denied(action),
        },
      }) + '\n',
    )
    process.exit(0)
  }
  process.exit(0)
} else {
  process.stderr.write('usage: guard.cjs check <tool> <args...> | hook\n')
  process.exit(2)
}
`

/** Writes the guard script, its config and the PATH shims; returns what each harness needs. */
export function installGuard(o: GuardOptions): GuardInstall {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seat-guard-'))
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(o.asksDir, { recursive: true })
  const script = path.join(dir, 'guard.cjs')
  fs.writeFileSync(script, GUARD_SCRIPT)
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      workdir: path.resolve(o.workdir),
      asksDir: o.asksDir,
      seatId: o.seatId,
      waitMs: o.waitMs ?? ASK_WAIT_MS,
      pollMs: o.pollMs ?? 500,
    }),
  )
  const run = `ELECTRON_RUN_AS_NODE=1 ${sh(o.node ?? process.execPath)} ${sh(script)}`
  for (const [tool, prefilter] of Object.entries(SHIMS)) {
    const realBin = whichIn(tool, o.path)
    if (realBin === null) continue
    const skip = prefilter
      ? `case " $* " in\n  ${prefilter}) ;;\n  *) exec ${sh(realBin)} "$@" ;;\nesac\n`
      : ''
    fs.writeFileSync(
      path.join(binDir, tool),
      `#!/bin/sh\n# Relay seat guard: outward actions wait for Isaac.\n${skip}${run} check ${sh(tool)} "$@" || exit 1\nexec ${sh(realBin)} "$@"\n`,
      { mode: 0o755 },
    )
  }
  const seatPathEnv = `${binDir}${path.delimiter}${o.path}`
  // Claude Code sources this before every Bash command, so the shims stay first even when its
  // shell snapshot restores the login PATH.
  const envFile = path.join(dir, 'claude-env.sh')
  fs.writeFileSync(envFile, `export PATH=${sh(binDir)}:"$PATH"\n`)
  const hookCommand = `${run} hook`
  const claudeSettings = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S }],
        },
      ],
    },
  })
  const codexArgs = [
    '-c',
    `hooks.PreToolUse=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout=${HOOK_TIMEOUT_S}}]}]`,
    '--dangerously-bypass-hook-trust',
  ]
  return {
    dir,
    binDir,
    env: { PATH: seatPathEnv, CLAUDE_ENV_FILE: envFile },
    hookCommand,
    claudeSettings,
    codexArgs,
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}
