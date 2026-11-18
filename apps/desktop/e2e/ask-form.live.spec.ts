import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './fixtures'
import { makeChatFixture } from './helpers/chat-fixture'
import { REPO_ROOT } from './helpers/paths'
import { startThrowawayHost } from './helpers/throwaway-host'

// Opt-in live proof (EVAOS_LIVE=1; spends one small model call): omp's `ask` tool, which since omp
// 18.18.3 opens one HTML form (ui.formDialog) instead of askDialog's questions, shows as the
// question card on desktop and the card's answers reach omp as the form's data. A real omp TUI runs
// in a pseudo-terminal (as herdr runs an assistant) with this checkout's relay-bridge extension,
// connected to a throwaway Relay host (apps/linux test/canvas-throwaway-host.ts); the hidden test
// app reads that host and the session's file. Nothing touches the live host or Isaac's sessions.
// EVAOS_ASK_FORM_VIDEO=<dir> keeps the recording (default test-results/ask-form).
const VIDEO = process.env.EVAOS_ASK_FORM_VIDEO ?? path.join(__dirname, '../test-results/ask-form')
const MODEL = process.env.EVAOS_ASK_FORM_MODEL ?? 'anthropic/claude-haiku-4-5'
const BRIDGE = path.join(REPO_ROOT, 'apps/linux/omp-extension/relay-bridge.ts')

const FORM = [
  '<form>',
  "<p>Round 1 on Solstice's restoration loop.</p>",
  '<fieldset><legend>1. How many steps from Blight to lush?</legend>',
  '<label><input type="radio" name="steps" value="two" checked> Two steps (recommended): a Purifier, then a Seeder.</label>',
  '<label><input type="radio" name="steps" value="one"> One step: straight to lush.</label>',
  '<label><input type="radio" name="steps" value="three"> Three steps: purify, water, seed.</label>',
  '</fieldset>',
  '<fieldset><legend>2. What is the fog?</legend>',
  '<label><input type="radio" name="fog" value="blight-fog" checked> Blight fog (recommended): lifts as land is reclaimed.</label>',
  '<label><input type="radio" name="fog" value="atmosphere"> Just atmosphere.</label>',
  '</fieldset>',
  '<label>3. Anything else? <textarea name="notes"></textarea></label>',
  '</form>',
].join(' ')

// The TUI needs a terminal: python's pty gives omp one, and its screen goes to a log for debugging.
const PTY = `
import os, pty, sys, select, signal, struct, fcntl, termios
log = open(sys.argv[1], "wb")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
signal.signal(signal.SIGTERM, lambda *_: (os.kill(pid, signal.SIGTERM), sys.exit(0)))
while not os.waitpid(pid, os.WNOHANG)[0]:
    if fd in select.select([fd], [], [], 1.0)[0]:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        log.write(data)
        log.flush()
`

/** This process's env minus anything that would tie the omp under test to a real Relay, herdr pane or assistant. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(RELAY_|HERDR_|JOB_|EVAOS_|OMP_|PI_)/.test(k)) env[k] = v
  }
  return env
}

test.skip(process.env.EVAOS_LIVE !== '1', 'runs a real omp and model call (EVAOS_LIVE=1)')
test.setTimeout(240_000)

interface Live {
  shell: Page
  card: Locator
  /** The text of omp's `ask` tool result in the session file, or '' while it has none. */
  askResult(): string
  /** The session file's text. */
  transcript(): string
  /** Closes the app (keeping its recording as `<video>.webm`), omp and the host. */
  stop(video?: string): Promise<void>
}

/** Starts the host, omp (told to ask FORM) and the app, opens the session's chat and waits for the card. */
async function startAsk(configDir: string): Promise<Live> {
  const fx = makeChatFixture()
  const host = await startThrowawayHost()
  const before = new Set(fs.readdirSync(fx.sessionsDir))
  const omp: ChildProcess = spawn(
    'python3',
    [
      '-c',
      PTY,
      path.join(fx.root, 'tui.log'),
      'omp',
      '--profile',
      'personal',
      '--model',
      MODEL,
      '--approval-mode',
      'yolo',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--extension',
      BRIDGE,
      '--session-dir',
      fx.sessionsDir,
    ],
    {
      cwd: fx.root,
      env: {
        ...cleanEnv(),
        TERM: 'xterm-256color',
        RELAY_AGENTS_SOCKET: host.agentsSocket,
        XDG_CONFIG_HOME: path.join(fx.root, 'xdg'),
        RELAY_GATE_CLI: '/usr/bin/true',
        RELAY_INITIAL_PROMPT: `Call the ask tool exactly once, with this as its html argument, verbatim: ${FORM} When it returns, reply with only the JSON it gave you, or if it failed, with one short sentence saying so.`,
      },
      stdio: 'ignore',
    },
  )
  const app = await launchApp(
    configDir,
    { ...fx.launchEnv, ...host.env },
    { dir: VIDEO, size: { width: 1280, height: 800 } },
  )
  const stop = async (video?: string): Promise<void> => {
    const recording = app.windows()[0]?.video()
    await app.close().catch(() => undefined)
    const saved = await recording?.path().catch(() => undefined)
    if (saved && video) fs.renameSync(saved, path.join(VIDEO, `${video}.webm`))
    else if (saved) fs.rmSync(saved, { force: true })
    omp.kill('SIGTERM')
    await host.stop()
    fx.cleanup()
  }
  try {
    const shell = await app.firstWindow()
    await shell.waitForSelector('[data-testid=rail]')
    // omp writes its session file once the prompt is in; its name carries the session id.
    let file = ''
    await expect
      .poll(
        () => {
          file =
            fs.readdirSync(fx.sessionsDir).find((n) => !before.has(n) && n.endsWith('.jsonl')) ?? ''
          return file
        },
        { timeout: 60_000 },
      )
      .not.toBe('')
    const id = file.slice(file.lastIndexOf('_') + 1, -'.jsonl'.length)
    await shell.locator('[data-testid="nav-chat"]').click()
    await shell.locator(`[data-testid="chat-row-${id}"]`).click()
    const card = shell.locator('[data-testid="pending-dialog"]')
    await expect(card).toContainText('How many steps from Blight to lush?', { timeout: 90_000 })
    const transcript = (): string => fs.readFileSync(path.join(fx.sessionsDir, file), 'utf8')
    const askResult = (): string => {
      for (const line of transcript().split('\n')) {
        if (!line.includes('"toolName":"ask"')) continue
        const entry = JSON.parse(line) as {
          message?: { role?: string; content?: Array<{ type: string; text?: string }> }
        }
        if (entry.message?.role === 'toolResult') return entry.message.content?.[0]?.text ?? ''
      }
      return ''
    }
    return { shell, card, askResult, transcript, stop }
  } catch (error) {
    await stop()
    throw error
  }
}

test("omp's ask form shows as the desktop question card and the card's answers come back as form data", async ({
  configDir,
}) => {
  const { shell, card, askResult, stop } = await startAsk(configDir)
  try {
    // The form, field by field: the intro leads the first question.
    await expect(card).toContainText("Round 1 on Solstice's restoration loop.")
    await expect(card).toContainText('1 of 3')
    await shell.waitForTimeout(1200)
    await card.getByRole('radio', { name: /Three steps/ }).click()
    await expect(card).toContainText('2. What is the fog?')
    await shell.waitForTimeout(800)
    await card.getByRole('radio', { name: /Just atmosphere/ }).click()
    await expect(card).toContainText('3. Anything else?')
    await card.getByRole('radio', { name: /Leave blank/ }).waitFor()
    await shell.waitForTimeout(600)
    await card.getByLabel('Your own answer').pressSequentially('Make the fog violet', { delay: 40 })
    await card.getByRole('button', { name: 'Send answer' }).click()
    await expect(card).toHaveCount(0)

    // omp got the form data the same answers submit in its terminal form.
    await expect.poll(askResult, { timeout: 30_000 }).toContain('"steps": "three"')
    expect(askResult()).toContain('"fog": "atmosphere"')
    expect(askResult()).toContain('"notes": "Make the fog violet"')
    await expect(shell.locator('[data-testid="chat-log"]')).toContainText('Answered', {
      timeout: 10_000,
    })
    await shell.waitForTimeout(2500)
    await stop('ask-form')
  } catch (error) {
    await stop('ask-form-failed')
    throw error
  }
})

test('a message sent while the card is open interrupts the ask and the turn goes on to it', async ({
  configDir,
}) => {
  const { shell, card, askResult, transcript, stop } = await startAsk(configDir)
  try {
    await shell.waitForTimeout(800)
    const box = shell.locator('[data-testid="composer-input"]')
    await box.fill('Skip the form, just say OK')
    await box.press('Enter')
    await expect(card).toHaveCount(0)
    // The tool returns (cut short) instead of the turn being aborted, and his message is in the turn.
    await expect.poll(askResult, { timeout: 30_000 }).toContain('Ask input was cancelled')
    await expect
      .poll(() => transcript().includes('Skip the form, just say OK'), { timeout: 30_000 })
      .toBe(true)
    expect(transcript()).not.toContain('Ask tool was cancelled by the user')
    await shell.waitForTimeout(2500)
    await stop('ask-form-interrupt')
  } catch (error) {
    await stop('ask-form-interrupt-failed')
    throw error
  }
})
