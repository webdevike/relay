import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Command } from '../eva/spawn'
import { planRun, runScript, type ScriptLine } from './runner'

const SETUP_DIR = path.resolve(__dirname, '../../../resources/setup')
const tmps: string[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-runner-'))
  tmps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const bash = (script: string, env: NodeJS.ProcessEnv = process.env): Command => ({
  file: '/bin/bash',
  argv: ['-c', script],
  env,
})

/** onLine for runScript plus a promise of the first PROGRESS line: the script is up and waiting. */
function firstProgress(): { onLine: (line: ScriptLine) => void; waiting: Promise<string> } {
  const { promise, resolve } = Promise.withResolvers<string>()
  return {
    onLine: (line) => {
      if (line.kind === 'progress') resolve(line.message)
    },
    waiting: promise,
  }
}

// Stands in for `omp login`: waits for the browser callback or a pasted code on stdin, and gives up
// as soon as stdin closes, as omp's readline prompt does. Only an open stdin can get it to OK.
const LOGIN = `echo "PROGRESS 10 waiting"; read -r line || { echo "Login failed: Login cancelled: stdin closed"; exit 1; }; echo "OK $line"`

describe('runScript', () => {
  it('plans the browser sign-in with stdin held open', () => {
    expect(planRun({ task: 'ai-login', provider: 'openai' }, os.homedir()).interactive).toBe(true)
    expect(planRun({ task: 'install', tool: 'omp' }, os.homedir()).interactive).toBeUndefined()
  })

  it('without an open stdin a login gives up at once (the localhost callback bug)', async () => {
    const job = runScript(bash(LOGIN), os.tmpdir(), { timeoutMs: 10_000 }, () => {})
    expect(await job.done).toEqual({
      ok: false,
      message: 'Login failed: Login cancelled: stdin closed',
    })
  })

  it('keeps an interactive script waiting until a pasted line arrives', async () => {
    const { onLine, waiting } = firstProgress()
    const job = runScript(
      bash(LOGIN),
      os.tmpdir(),
      { interactive: true, timeoutMs: 10_000 },
      onLine,
    )
    await waiting
    expect(job.send('http://localhost:1455/auth/callback?code=abc\n')).toBe(true)
    expect(await job.done).toEqual({
      ok: true,
      version: 'http://localhost:1455/auth/callback?code=abc',
    })
    expect(job.send('again')).toBe(false)
  })

  it('refuses input to a script that is not interactive', async () => {
    const job = runScript(bash('echo "OK done"'), os.tmpdir(), { timeoutMs: 10_000 }, () => {})
    expect(job.send('x')).toBe(false)
    expect(await job.done).toEqual({ ok: true, version: 'done' })
  })

  it('cancel ends the whole process group, so no child keeps a port', async () => {
    const { onLine, waiting } = firstProgress()
    // The backgrounded sleep shares stdout, and `done` settles only once every holder of stdout has
    // exited: without the group kill this would hang on the orphaned sleep.
    const job = runScript(
      bash('sleep 30 & echo "PROGRESS 5 started"; wait'),
      os.tmpdir(),
      { interactive: true, timeoutMs: 20_000 },
      onLine,
    )
    await waiting
    job.cancel()
    expect(await job.done).toEqual({ ok: false, message: 'Cancelled' })
  })
})

describe.skipIf(process.platform !== 'darwin')('ai-login.sh browser sign-in', () => {
  /** A HOME whose ~/.local/bin/omp fakes `omp login` and `omp usage accounts --json`. */
  function fakeHome(): { home: string; env: NodeJS.ProcessEnv } {
    const home = tmp()
    const bin = path.join(home, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const signedIn = path.join(home, 'signed-in')
    fs.writeFileSync(
      path.join(bin, 'omp'),
      [
        '#!/bin/bash',
        'if [ "$1" = usage ]; then',
        `  if [ -f ${JSON.stringify(signedIn)} ]; then echo '{"accounts":[{"provider":"openai-codex"}]}'; else echo '{"accounts":[]}'; fi`,
        '  exit 0',
        'fi',
        'echo "Waiting for browser authentication..."',
        'read -r line || { echo "Login failed: Login cancelled: stdin closed"; exit 1; }',
        `case "$line" in *code=*) touch ${JSON.stringify(signedIn)} ;; *) printf 'Login failed: openai-codex token exchange failed: 401 {\\n  "code": "token_expired"\\n}\\n'; exit 1 ;; esac`,
      ].join('\n'),
      { mode: 0o755 },
    )
    return {
      home,
      env: { PATH: '/usr/bin:/bin', HOME: home, RELAY_SETUP_LOG_DIR: path.join(home, 'logs') },
    }
  }

  const aiLogin = (env: NodeJS.ProcessEnv): Command => ({
    file: '/bin/bash',
    argv: [path.join(SETUP_DIR, 'ai-login.sh'), 'openai'],
    env,
  })

  it('waits for the redirect and finishes with the pasted address', async () => {
    const { home, env } = fakeHome()
    const { onLine, waiting } = firstProgress()
    const job = runScript(
      aiLogin(env),
      home,
      planRun({ task: 'ai-login', provider: 'openai' }, home),
      onLine,
    )
    await waiting
    expect(job.send('http://localhost:1455/auth/callback?code=abc&state=s')).toBe(true)
    expect(await job.done).toEqual({ ok: true, version: 'openai' })
  })

  it('reports a closed stdin as a cancelled sign-in', async () => {
    const { home, env } = fakeHome()
    const job = runScript(aiLogin(env), home, { timeoutMs: 10_000 }, () => {})
    expect(await job.done).toEqual({ ok: false, message: 'sign-in to openai was cancelled' })
  })

  it("reports omp's failure line without the provider's JSON body", async () => {
    const { home, env } = fakeHome()
    const { onLine, waiting } = firstProgress()
    const job = runScript(
      aiLogin(env),
      home,
      planRun({ task: 'ai-login', provider: 'openai' }, home),
      onLine,
    )
    await waiting
    job.send('not-a-code')
    expect(await job.done).toEqual({
      ok: false,
      message: 'sign-in to openai did not finish: openai-codex token exchange failed: 401',
    })
  })
})
