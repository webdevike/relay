import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * Settings > Setup > Long-term memory on a starter home, with a stand-in `uv` that lays down a
 * fake hindsight-api (a tiny Python HTTP server). Everything else is real: the install steps, the
 * run script, a LaunchAgent in the user's launchd domain (under a throwaway label), the omp
 * config.yml edit, the status poll and the UI. macOS only.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mem-e2e-'))
const label = `ai.relay.hindsight.e2e${process.pid}`
const nativeDir = path.join(home, 'Library/Application Support/Relay/hindsight')
const launchAgents = path.join(home, 'Library/LaunchAgents')
const port = 28000 + (process.pid % 1000)
const fakeUv = path.join(home, 'fake-uv')

const FAKE_API = `#!/usr/bin/env python3
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
OPS = os.path.join(os.path.dirname(os.path.realpath(sys.argv[0])), '..', '..', 'ops.json')
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if '/operations' in self.path:
            try: ops = json.load(open(OPS))
            except Exception: ops = []
            return self.reply({'operations': ops})
        self.reply({'status': 'healthy'})
    def do_PUT(self): self.reply({'ok': True})
HTTPServer(('127.0.0.1', int(os.environ['HINDSIGHT_API_PORT'])), H).serve_forever()
`

/** The three uv calls Relay makes: --version, venv, pip install [--upgrade]. */
const FAKE_UV = `#!/bin/sh
case "$1" in
  --version) echo "uv 0.0.0-fake" ;;
  venv)
    mkdir -p "$4/bin" && cp /usr/bin/python3 "$4/bin/python" 2>/dev/null || ln -sf /usr/bin/python3 "$4/bin/python" ;;
  pip)
    VENV="$(dirname "$(dirname "$(printf '%s\\n' "$@" | grep '/venv/bin/python$')")")"
    V=1.2.0; case "$*" in *--upgrade*) V=1.3.0 ;; esac
    SITE="$VENV/lib/python3.12/site-packages"
    rm -rf "$SITE"/hindsight_api-*.dist-info; mkdir -p "$SITE/hindsight_api-$V.dist-info"
    cat > "$VENV/bin/hindsight-api" <<'PY'
${FAKE_API}PY
    chmod +x "$VENV/bin/hindsight-api" ;;
esac
`

test.use({ startOnChat: false, colorScheme: 'dark' })
test.use({
  launchEnv: {
    HOME: home,
    EVAOS_LIVE: '1',
    EVAOS_EVA_ROOT: '',
    EVAOS_AGENT_DIR: path.join(home, '.omp/agent'),
    RELAY_HINDSIGHT_DIR: nativeDir,
    RELAY_HINDSIGHT_LABEL: label,
    RELAY_HINDSIGHT_LAUNCH_AGENTS: launchAgents,
    RELAY_HINDSIGHT_PORT: String(port),
    RELAY_HINDSIGHT_UV: fakeUv,
    RELAY_HINDSIGHT_RAM_GB: '64',
  },
})

test.beforeAll(() => {
  fs.mkdirSync(path.join(home, 'Relay/.omp/assistant'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'Relay/.omp/assistant/agents.json'),
    JSON.stringify({ agents: [{ id: 'ada', title: 'Ada' }] }),
  )
  fs.mkdirSync(path.join(home, '.omp/agent'), { recursive: true })
  // A ChatGPT login is on hand: no key to ask for, and no model on this Mac to offer.
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex/auth.json'), '{}')
  fs.writeFileSync(fakeUv, FAKE_UV, { mode: 0o755 })
})

test.beforeEach(({ configDir }) => {
  fs.writeFileSync(
    path.join(configDir, 'home.json'),
    JSON.stringify({ root: path.join(home, 'Relay'), profile: 'starter', setupComplete: true }),
  )
})

test.afterAll(() => {
  const uid = process.getuid?.() ?? 0
  try {
    execFileSync('/bin/launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
  fs.rmSync(home, { recursive: true, force: true })
})

interface Hooks {
  openPlace(page: string, newTab?: boolean, extra?: { settingsSection: string }): void
}
type W = { __evaosShell?: Hooks }

async function openSetup(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as W).__evaosShell))
  await page.evaluate(() =>
    (window as unknown as W).__evaosShell!.openPlace('settings', false, {
      settingsSection: 'Setup',
    }),
  )
  await page.waitForSelector('[data-testid=settings-memory]')
}

test('installs without Docker, shows what it is, updates, turns off and removes', async ({
  shell,
}) => {
  await openSetup(shell)
  const memory = shell.getByTestId('settings-memory')
  const controls = memory.getByTestId('memory-controls')

  // Nothing installed: ready, native, honest about the size; Docker is not mentioned.
  await expect(controls).toHaveAttribute('data-phase', 'ready')
  await expect(controls).toHaveAttribute('data-engine', 'native')
  await expect(memory.getByTestId('memory-size-note')).toContainText('about 2.5 GB')
  await expect(memory).not.toContainText('Docker')

  await memory.getByTestId('memory-install').click()
  await expect(memory.getByTestId('memory-ok')).toBeVisible({ timeout: 60_000 })
  await expect(memory.getByTestId('memory-version')).toContainText('Hindsight 1.2.0')
  await expect(memory.getByTestId('memory-version')).toContainText('your ChatGPT sign-in')

  // What Relay put on disk and in omp's config.
  expect(fs.existsSync(path.join(nativeDir, 'venv/bin/hindsight-api'))).toBe(true)
  expect(fs.readFileSync(path.join(nativeDir, 'run.sh'), 'utf8')).toContain(
    'HINDSIGHT_API_HOST=127.0.0.1',
  )
  expect(fs.existsSync(path.join(launchAgents, `${label}.plist`))).toBe(true)
  const cfg = fs.readFileSync(path.join(home, '.omp/agent/config.yml'), 'utf8')
  expect(cfg).toContain('backend: hindsight')
  expect(cfg).toContain(`apiUrl: http://127.0.0.1:${port}`)
  await shell.screenshot({ path: test.info().outputPath('memory-on.png') })

  // A failed retain shows up as "Memory isn't saving", with the sign-in fix.
  fs.writeFileSync(
    path.join(nativeDir, 'ops.json'),
    JSON.stringify([
      {
        status: 'pending',
        error_message:
          "Codex authentication failed and the refresh_token is no longer valid.\\nRun 'codex auth login' to re-authenticate.",
      },
    ]),
  )
  await memory.getByTestId('memory-update').click()
  await expect(memory.getByTestId('memory-problem')).toContainText("Memory isn't saving")
  await expect(memory.getByTestId('memory-fix')).toHaveText('Sign in again')
  await expect(memory.getByTestId('memory-ok')).toHaveCount(0)
  await shell.screenshot({ path: test.info().outputPath('memory-problem.png') })
  fs.rmSync(path.join(nativeDir, 'ops.json'))

  // The failure clears once Hindsight's newest operation is fine; a second Update refreshes
  // the status (and finds nothing newer than 1.3.0).
  await memory.getByTestId('memory-update').click()
  await expect(memory.getByTestId('memory-ok')).toBeVisible({ timeout: 60_000 })
  await expect(memory.getByTestId('memory-version')).toContainText('Hindsight 1.3.0')

  // Turn off keeps the install, takes omp off it and removes the LaunchAgent.
  await memory.getByTestId('memory-disable').click()
  await expect(controls).toHaveAttribute('data-phase', 'repair', { timeout: 30_000 })
  expect(fs.existsSync(path.join(launchAgents, `${label}.plist`))).toBe(false)
  expect(fs.existsSync(path.join(nativeDir, 'venv'))).toBe(true)
  expect(fs.readFileSync(path.join(home, '.omp/agent/config.yml'), 'utf8')).not.toContain(
    'backend: hindsight',
  )

  // Set up again reuses it (no download); then remove deletes everything.
  await memory.getByTestId('memory-install').click()
  await expect(memory.getByTestId('memory-ok')).toBeVisible({ timeout: 60_000 })
  await memory.getByTestId('memory-remove').click()
  await memory.getByTestId('memory-remove-confirm').click()
  await expect(controls).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 })
  expect(fs.existsSync(nativeDir)).toBe(false)
  expect(fs.existsSync(path.join(launchAgents, `${label}.plist`))).toBe(false)
})

test('a Mac with 32 GB or more offers a model that runs on it, with what it costs', async ({
  shell,
}) => {
  // Without the ChatGPT login there is nothing else to read with.
  fs.renameSync(path.join(home, '.codex/auth.json'), path.join(home, '.codex/auth.off'))
  try {
    await openSetup(shell)
    const memory = shell.getByTestId('settings-memory')
    await expect(memory.getByTestId('memory-controls')).toHaveAttribute('data-phase', 'ready')
    const cost = memory.getByTestId('memory-local-cost')
    await expect(cost).toContainText('17.2 GB')
    await expect(cost).toContainText('18.0 GB of memory')
    await expect(memory.getByTestId('memory-size-note')).toContainText('plus the model')
    await shell.screenshot({ path: test.info().outputPath('memory-local-offer.png') })
  } finally {
    fs.renameSync(path.join(home, '.codex/auth.off'), path.join(home, '.codex/auth.json'))
  }
})
