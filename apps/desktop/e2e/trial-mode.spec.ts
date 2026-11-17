// Trial mode on a host with the "trials" feature: a taste agent's request runs on three models and
// the assistant's chat shows the card, A / B / C side by side with no model names. Each result fills
// its own pane as it arrives; Isaac picks B (`trial.pick`, surface desktop), and the revealed card
// names the models under the letters with the buttons gone. The agent's switch message has an Undo
// (`trial.undo`); once undone it says so. A fake host on a real WebSocket stands in for Relay.
//
// Screenshots: proof/trial-mode/desktop-streaming.png, desktop-revealed.png, desktop-switch.png
//
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/trial-mode.spec.ts --retries 0 --max-failures 1
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'

const PROOF = path.join(REPO_ROOT, 'proof', 'trial-mode')

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({ agents: [{ id: 'nova', title: 'Nova', scope: 'Personal' }] }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', 'trials']
    // Two diagrams as the host serves an agent's images (drops): boxes in different layouts.
    for (const [drop, boxes] of [
      [
        '/drops/diagram-a/tok',
        'drawbox=x=40:y=60:w=150:h=90:color=0x3b82f6:t=fill,drawbox=x=290:y=150:w=150:h=90:color=0x22c55e:t=fill,drawbox=x=190:y=100:w=100:h=6:color=0x64748b:t=fill',
      ],
      [
        '/drops/diagram-b/tok',
        'drawbox=x=165:y=20:w=150:h=70:color=0x3b82f6:t=fill,drawbox=x=165:y=120:w=150:h=70:color=0xeab308:t=fill,drawbox=x=165:y=220:w=150:h=60:color=0x22c55e:t=fill,drawbox=x=237:y=90:w=6:h=130:color=0x64748b:t=fill',
      ],
    ] as const) {
      const out = path.join(fx.root, `${path.basename(path.dirname(drop))}.png`)
      execFileSync('ffmpeg', [
        ...['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=white:s=480x300,${boxes}`],
        ...['-frames:v', '1', out],
      ])
      host.serveFile(drop, fs.readFileSync(out), 'image/png')
    }
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)
const THREAD = 'assistant:nova'
const PROMPT_AT = 1792486874000
const REPLY_AT = 1792486880000
// The request came in a moment ago (after the reply that asked), so the running clock reads it.
const TRIAL_AT = Math.max(Date.now() - 12_000, REPLY_AT + 2000)
const MODELS = { A: 'GPT-6.1 Sol', B: 'Sonnet 5.5', C: 'Opus 5.5' } as const
const PREVIEW = {
  A: '![Deploy flow](/drops/diagram-a/tok)',
  B: '![Deploy flow](/drops/diagram-b/tok)',
  C: '**Deploy flow**\n\n1. Build the app\n2. Run the tests\n3. Ship to the Mini',
} as const
type Letter = keyof typeof MODELS

const arm = (letter: Letter, done: boolean, revealed = false) => ({
  letter,
  status: done ? 'done' : 'running',
  ...(done ? { preview: PREVIEW[letter], seconds: 20 } : {}),
  ...(revealed ? { model: `model-${letter}`, modelLabel: MODELS[letter] } : {}),
})
const card = (done: Letter[], extra: Record<string, unknown> = {}, revealed = false) => ({
  id: 'trial-1',
  agent: 'diagram',
  label: 'Diagram',
  thread: THREAD,
  at: TRIAL_AT,
  request: 'A flow chart of the deploy pipeline',
  arms: (['A', 'B', 'C'] as const).map((l) => arm(l, done.includes(l), revealed)),
  ...extra,
})
const change = (undone: boolean) => ({
  id: 'switch-1',
  agent: 'diagram',
  label: 'Diagram',
  thread: THREAD,
  at: TRIAL_AT + 60_000,
  text: 'Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks over Opus 5.5 and GPT-6.1 Sol',
  from: 'model-C',
  to: 'model-B',
  fromLabel: 'Opus 5.5',
  toLabel: 'Sonnet 5.5',
  kept: false,
  undone,
})

test('a trial card fills pane by pane, reveals the models after a pick, and the switch message undoes', async ({
  shell,
}) => {
  fs.mkdirSync(PROOF, { recursive: true })
  fs.writeFileSync(
    path.join(fx.sessionsDir, '2026-11-04T10-00-00-000Z_nova-1.jsonl'),
    [
      line({
        type: 'session',
        version: 3,
        id: 'nova-1',
        timestamp: new Date().toISOString(),
        cwd: fx.root,
      }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'Draw me the deploy flow.', timestamp: PROMPT_AT },
      }),
      line({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Asking Diagram for the deploy flow.' }],
          stopReason: 'stop',
          timestamp: REPLY_AT,
        },
      }),
    ].join('\n') + '\n',
  )
  host.upsert({ id: 'nova-1', status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await expect(shell.locator(sel('bubble-a1'))).toContainText('Asking Diagram', { timeout: 10_000 })
  // The app asks a host with the feature for its cards when it connects.
  await expect.poll(() => host.trialFrames.some((f) => f.t === 'trials.get')).toBe(true)

  // 1. Three arms running: big letters, a running state each, nothing to pick yet.
  host.setTrials([card([])])
  const trial = shell.locator(sel('trial-trial-1'))
  await expect(trial).toBeVisible()
  await expect(trial).toContainText('Diagram · which is better?')
  const pane = (l: Letter) => trial.locator(sel(`trial-pane-${l}`))
  for (const l of ['A', 'B', 'C'] as const) {
    await expect(pane(l)).toHaveAttribute('data-status', 'running')
    await expect(pane(l).locator('.eva-trial-letter')).toHaveText(l)
  }
  await expect(trial.locator(sel('trial-pick-B'))).toBeDisabled()
  await expect(trial.locator(sel('trial-pick-unsure'))).toBeDisabled()
  // The card sits after the reply that asked, in the chat's order.
  const replyBox = (await shell.locator(sel('msg-a1')).boundingBox())!
  const cardBox = (await trial.boundingBox())!
  expect(cardBox.y).toBeGreaterThanOrEqual(replyBox.y + replyBox.height - 1)
  const height = cardBox.height

  // 2. Results arrive one at a time, each filling only its own pane.
  host.setTrials([card(['B'])])
  await expect(pane('B')).toHaveAttribute('data-status', 'done')
  await expect(pane('B').locator(sel('md-image'))).toBeVisible()
  await expect(pane('A')).toHaveAttribute('data-status', 'running')
  await expect(pane('C')).toHaveAttribute('data-status', 'running')
  // One result is nothing to compare yet.
  await expect(trial.locator(sel('trial-pick-B'))).toBeDisabled()

  host.setTrials([card(['B', 'C'])])
  await expect(pane('C')).toHaveAttribute('data-status', 'done')
  await expect(pane('C')).toContainText('Run the tests')
  await expect(pane('A')).toHaveAttribute('data-status', 'running')
  await expect(trial.locator(sel('trial-pick-B'))).toBeEnabled()
  await expect(trial.locator(sel('trial-pick-unsure'))).toBeEnabled()
  await expect(trial.locator(sel('trial-pick-A'))).toBeDisabled()
  for (const name of Object.values(MODELS)) await expect(trial).not.toContainText(name)
  // Results filling in never change the card's height, so the log around it stays put.
  expect(Math.abs((await trial.boundingBox())!.height - height)).toBeLessThan(1)
  await shell.mouse.move(0, 0)
  await trial.screenshot({ path: path.join(PROOF, 'desktop-streaming.png') })

  host.setTrials([card(['A', 'B', 'C'])])
  await expect(pane('A')).toHaveAttribute('data-status', 'done')
  await expect(pane('A').locator(sel('md-image'))).toBeVisible()
  await expect(trial.locator(sel('trial-pick-A'))).toBeEnabled()
  for (const name of Object.values(MODELS)) await expect(trial).not.toContainText(name)

  // 3. Isaac picks B: the host hears it from the desktop.
  await trial.locator(sel('trial-pick-B')).click()
  await expect
    .poll(() => host.trialFrames.filter((f) => f.t === 'trial.pick'))
    .toEqual([{ t: 'trial.pick', trial: 'trial-1', pick: 'B', surface: 'desktop' }])

  // 4. The revealed card: the models under the letters, B marked, the buttons gone.
  host.setTrials([card(['A', 'B', 'C'], { pick: 'B', pickedAt: TRIAL_AT + 30_000 }, true)])
  for (const l of ['A', 'B', 'C'] as const)
    await expect(trial.locator(sel(`trial-model-${l}`))).toHaveText(MODELS[l])
  await expect(pane('B')).toHaveAttribute('data-picked', 'true')
  await expect(pane('A')).not.toHaveAttribute('data-picked', 'true')
  await expect(trial.locator('[data-testid^="trial-pick-"]')).toHaveCount(0)
  await expect(trial).toContainText('Diagram · you picked B')
  await shell.mouse.move(0, 0)
  await trial.screenshot({ path: path.join(PROOF, 'desktop-revealed.png') })

  // 5. The agent switches on its own: its message, with an Undo.
  const revealed = card(['A', 'B', 'C'], { pick: 'B', pickedAt: TRIAL_AT + 30_000 }, true)
  host.setTrials([revealed], [change(false)])
  const msg = shell.locator(sel('trial-switch-switch-1'))
  await expect(msg).toContainText(
    'Diagram: switched to Sonnet 5.5, won 8 of your last 10 picks over Opus 5.5 and GPT-6.1 Sol',
  )
  await expect(msg.locator(sel('trial-undo'))).toHaveText('Undo')
  await shell.mouse.move(0, 0)
  await shell.locator(sel('chat-pane')).screenshot({ path: path.join(PROOF, 'desktop-switch.png') })

  // 6. Undo goes to the host; once it is undone the message says so and the button goes.
  await msg.locator(sel('trial-undo')).click()
  await expect
    .poll(() => host.trialFrames.filter((f) => f.t === 'trial.undo'))
    .toEqual([{ t: 'trial.undo', switch: 'switch-1' }])
  host.setTrials([revealed], [change(true)])
  await expect(msg.locator(sel('trial-undone'))).toHaveText(
    'Undone: back on Opus 5.5, trial on again',
  )
  await expect(msg.locator(sel('trial-undo'))).toHaveCount(0)
  await shell
    .locator(sel('chat-pane'))
    .screenshot({ path: path.join(PROOF, 'desktop-switch-undone.png') })
})
