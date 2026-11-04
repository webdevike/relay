import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// An assistant's portrait moves calmly with its thread (@relay/portrait-motion): the start card
// rests at Idle, thinks once its turn runs, researches while Relay hears a search and works while a
// command runs; a streaming reply is still Thinking, and needing Isaac or failing keeps a resting
// face. The face alone shows state on the avatar (no ring, no dot); the crumb's muted words say it
// too ("is researching", "needs you", "hit a snag"). A fake Relay host on a real WebSocket lists the
// thread and streams its reply; the thread file is written like omp writes it. Tests run with
// motion off, so states are asserted from `data-state` and the words. EVAOS_MOTION_PROOF=<dir>
// runs only the proof instead: motion on, Nova's and Astra's start cards (Extended mode) through
// Idle, Thinking, Researching and Snoozing recorded as JPEG screencast frames in <dir>/frames, and
// the app's CPU sampled into <dir>/cpu.json.
const PROOF = process.env.EVAOS_MOTION_PROOF ?? ''

const NOVA = {
  style: 'micah',
  seed: 'nova-17',
  options: {
    base: ['standard'],
    earringsProbability: 0,
    ears: ['attached'],
    eyebrows: ['eyelashesDown'],
    eyes: ['eyes'],
    facialHairProbability: 0,
    glasses: ['round'],
    glassesProbability: 100,
    hair: ['full'],
    hairProbability: 100,
    mouth: ['smile'],
    nose: ['curve'],
    shirt: ['crew'],
    baseColor: ['b16a5b'],
    hairColor: ['e0ddff'],
    shirtColor: ['000000'],
  },
  colors: { paper: '#e7f5ff', accent: '#f76707' },
}

let fx: ChatFixture
let host: FakeRelayHost
let evaRoot: string
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [
          { id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' },
          { id: 'nova', title: 'Nova', scope: 'Personal', avatar: NOVA },
        ],
      }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)

/** The proof's beats last this long, so a video shows each face move. */
const BEAT_MS = 4_000

/** Nova's thread as Relay lists it. */
const NOVA_THREAD: HostSession = {
  id: 'nova-1',
  status: 'working',
  kind: 'assistant',
  assistant: 'nova',
  title: 'Nova',
}

test("an assistant's portrait thinks, researches and works with its thread; its crumb says so", async ({
  shell,
}) => {
  test.skip(PROOF !== '', 'EVAOS_MOTION_PROOF runs the proof only')
  await shell.locator(sel('nav-assistants')).click()

  // 1. The start card rests at Idle; the crumb says nothing more than the name.
  await shell.locator(sel('sidebar-agent-nova')).click()
  const card = shell.locator(`${sel('agent-start-nova')} ${sel('agent-portrait-nova')}`)
  const side = shell.locator(sel('sidebar-portrait-nova'))
  const words = shell.locator(`${sel('agent-crumb-status')} > span:not([data-leaving])`)
  await expect(card).toHaveAttribute('data-state', 'idle')
  // At rest the notch's muted word is "idle" (AgentCrumb.test pins it).
  await expect(words).toHaveText('idle')
  // No ring or status dot on any avatar.
  await expect(shell.locator('.eva-pm-ring, .eva-pm-dot, .eva-pmc-dot, .eva-pmc-ring')).toHaveCount(
    0,
  )

  // 2. Start goes through Relay and Relay lists the thread working: Thinking.
  await shell.locator(sel('start-nova')).click()
  await expect.poll(() => host.kinds()).toContain('assistant.turn')
  host.upsert(NOVA_THREAD)
  await expect(card).toHaveAttribute('data-state', 'thinking')
  await expect(side).toHaveAttribute('data-state', 'thinking')
  await expect(words).toHaveText('is thinking')

  // 3. Relay hears a web search: Researching, the magnifier on the card.
  host.upsert({ ...NOVA_THREAD, statusDetail: 'web_search' })
  await expect(card).toHaveAttribute('data-state', 'researching')
  await expect(side).toHaveAttribute('data-state', 'researching')
  await expect(words).toHaveText('is researching')

  // 4. Then a command: Working.
  host.upsert({ ...NOVA_THREAD, statusDetail: 'bash' })
  await expect(card).toHaveAttribute('data-state', 'working')
  await expect(words).toHaveText('is working')

  // 5. omp writes the thread: the page is the conversation, its tool returned, Nova thinks.
  const file = path.join(fx.sessionsDir, '2026-10-27T20-00-00-000Z_nova-1.jsonl')
  fs.writeFileSync(
    file,
    [
      line({
        type: 'session',
        version: 3,
        id: 'nova-1',
        timestamp: new Date().toISOString(),
        cwd: evaRoot,
      }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'Hi Nova' },
      }),
      line({
        type: 'message',
        id: 'c1',
        parentId: 'u1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'web_search',
              arguments: { query: 'dentist hours' },
            },
          ],
        },
      }),
      line({
        type: 'message',
        id: 'r1',
        parentId: 'c1',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'web_search',
          content: [{ type: 'text', text: 'Open until 5' }],
        },
      }),
    ].join('\n') + '\n',
  )
  host.upsert({ ...NOVA_THREAD, statusDetail: '' })
  // The thread's portrait sits in the header notch (the crumb carries only the way back).
  const crumb = shell.locator(`${sel('agent-notch')} ${sel('agent-portrait-nova')}`)
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Nova', { timeout: 10_000 })
  await expect(crumb).toHaveAttribute('data-state', 'thinking')

  // 6. The reply streams in: still Thinking.
  await expect.poll(() => host.subscribed('nova-1')).toBe(true)
  const answer = 'Hi Isaac! The dentist is open until 5 today.'
  host.stream('nova-1', 'm1', 'Hi Isaac!', true)
  await expect(shell.locator(sel('msg-relay-stream'))).toContainText('Hi Isaac!')
  await expect(crumb).toHaveAttribute('data-state', 'thinking')

  // 7. The turn ends: Idle, and the notch says so.
  host.stream('nova-1', 'm1', answer, false)
  await fx.append(
    'nova-1',
    line({
      type: 'message',
      id: 'a1',
      parentId: 'r1',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop' },
    }),
  )
  host.upsert({ ...NOVA_THREAD, status: 'idle' })
  await expect(crumb).toHaveAttribute('data-state', 'idle')
  await expect(words).toHaveText('idle')

  // 8. omp's ask tool waits on Isaac (Relay still says working): a resting face, "needs you".
  host.upsert({ ...NOVA_THREAD, statusDetail: 'ask' })
  host.ask('nova-1', {
    id: 'k1',
    questions: [
      {
        id: 'q1',
        question: 'Move the dentist to Friday?',
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  })
  await expect(side).toHaveAttribute('data-state', 'idle')
  await expect(crumb).toHaveAttribute('data-state', 'idle')
  await expect(words).toHaveText('needs you')
  await shell.locator(sel('pending-dialog')).getByRole('radio', { name: /Yes/ }).click()
  await expect(shell.locator(sel('pending-dialog'))).toHaveCount(0)

  // 9. The next turn runs a command and fails: Working, then a resting face that "hit a snag".
  host.upsert({ ...NOVA_THREAD, statusDetail: 'bash' })
  await expect(crumb).toHaveAttribute('data-state', 'working')
  await fx.append(
    'nova-1',
    line({
      type: 'message',
      id: 'a2',
      parentId: 'a1',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'rate limited',
      },
    }),
  )
  host.upsert({ ...NOVA_THREAD, status: 'idle' })
  await expect(crumb).toHaveAttribute('data-state', 'idle')
  await expect(side).toHaveAttribute('data-state', 'idle')
  await expect(words).toHaveText('hit a snag')
})

test("proof: the start cards' Extended faces (Idle blinks, Thinking, Researching, Snoozing) and CPU", async ({
  app,
  shell,
}) => {
  test.skip(PROOF === '', 'set EVAOS_MOTION_PROOF=<dir> to record')
  test.setTimeout(300_000)
  await shell.locator(sel('nav-assistants')).click()
  const cpu = await cpuSampler(app, shell)
  await measureCard(app, shell, cpu)
  const stopRecording = await record(shell)
  for (const id of ['nova', 'astra']) {
    const thread: HostSession = {
      id: `${id}-1`,
      status: 'working',
      kind: 'assistant',
      assistant: id,
    }
    await shell.locator(sel(`sidebar-agent-${id}`)).click()
    const card = shell.locator(`${sel(`agent-start-${id}`)} ${sel(`agent-portrait-${id}`)}`)
    await expect(card).toHaveAttribute('data-state', 'idle')
    await shell.waitForTimeout(BEAT_MS + 1_000)
    host.upsert(thread)
    await expect(card).toHaveAttribute('data-state', 'thinking')
    await shell.waitForTimeout(BEAT_MS)
    host.upsert({ ...thread, statusDetail: 'web_search' })
    await expect(card).toHaveAttribute('data-state', 'researching')
    await shell.waitForTimeout(BEAT_MS)
    await shell.screenshot({ path: path.join(PROOF, `${id}-researching.png`) })
    host.upsert({ ...thread, statusDetail: 'bash' })
    await expect(card).toHaveAttribute('data-state', 'working')
    await shell.waitForTimeout(BEAT_MS)
    await shell.screenshot({ path: path.join(PROOF, `${id}-working.png`) })
    // The start card has no thread to go quiet for half an hour: lay that over its signals.
    host.upsert({ ...thread, status: 'idle', statusDetail: '' })
    await shell.evaluate(
      (a) =>
        (
          window as unknown as {
            __evaosShell: { portraitSignals(id: string, p: object | null): void }
          }
        ).__evaosShell.portraitSignals(a, { activityAt: Date.now() - 31 * 60_000 }),
      id,
    )
    await expect(card).toHaveAttribute('data-state', 'snoozing')
    await shell.waitForTimeout(BEAT_MS + 1_000)
  }
  await stopRecording()
  cpu.write()
})

/** Screencast frames (CDP) into `<PROOF>/frames`, named by their timestamps; resolves a stopper. */
async function record(shell: Page): Promise<() => Promise<void>> {
  const dir = path.join(PROOF, 'frames')
  fs.mkdirSync(dir, { recursive: true })
  const cdp = await shell.context().newCDPSession(shell)
  cdp.on('Page.screencastFrame', (f) => {
    fs.writeFileSync(
      path.join(dir, `${f.metadata.timestamp!.toFixed(3)}.jpg`),
      Buffer.from(f.data, 'base64'),
    )
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
  return async () => {
    await cdp.send('Page.stopScreencast')
    await cdp.detach()
  }
}

/** CPU seconds the app's processes used so far, by pid (ps's cumulative `time`). */
function cpuTimes(pids: number[]): Map<number, number> {
  const out = execFileSync('ps', ['-o', 'pid=,time=', '-p', pids.join(',')], { encoding: 'utf8' })
  const times = new Map<number, number>()
  for (const row of out.trim().split('\n')) {
    const [pid, time] = row.trim().split(/\s+/)
    const parts = time!.split(':').map(Number)
    times.set(
      Number(pid),
      parts.reduce((s, v) => s * 60 + v, 0),
    )
  }
  return times
}

interface CpuSampler {
  /** Samples the app's CPU % over 10 s (after 2 s to settle). */
  sample(label: string): Promise<void>
  /** Turns motion on or off as the app's motion setting does. */
  motion(on: boolean): Promise<void>
  write(): void
}

/**
 * Samples the renderer (the shell window's process), GPU process and main CPU % over 10 s windows
 * from ps cputime deltas, into `<PROOF>/cpu.json`.
 */
async function cpuSampler(app: ElectronApplication, shell: Page): Promise<CpuSampler> {
  const procs = await app.evaluate(({ app: a, webContents }) => {
    const shellPid = webContents
      .getAllWebContents()
      .find((w) => w.getURL().includes('index.html'))
      ?.getOSProcessId()
    return {
      shellPid,
      gpu: a.getAppMetrics().find((m) => m.type === 'GPU')?.pid,
      main: process.pid,
    }
  })
  const pids = { renderer: procs.shellPid!, gpu: procs.gpu!, main: procs.main }
  const samples: Record<string, unknown>[] = []
  return {
    async sample(label: string): Promise<void> {
      await shell.waitForTimeout(2_000)
      const list = Object.values(pids)
      const a = cpuTimes(list)
      const t0 = Date.now()
      await shell.waitForTimeout(10_000)
      const b = cpuTimes(list)
      const secs = (Date.now() - t0) / 1000
      const pct = (pid: number) => Math.round(((b.get(pid)! - a.get(pid)!) / secs) * 1000) / 10
      samples.push({
        label,
        seconds: secs,
        visibility: await shell.evaluate(() => document.visibilityState),
        pageHidden: await shell.evaluate(() => document.documentElement.dataset['evaPageHidden']),
        rendererPct: pct(pids.renderer),
        gpuPct: pct(pids.gpu),
        mainPct: pct(pids.main),
        // What still runs: CSS animations by name and the class of what they move.
        animations: await shell.evaluate(() =>
          document
            .getAnimations()
            .filter((x) => x.playState === 'running')
            .map((x) => {
              const target = (x.effect as KeyframeEffect | null)?.target
              return `${(x as CSSAnimation).animationName}@${String(target?.className ?? '')}`
            }),
        ),
      })
    },
    motion: (on: boolean) =>
      shell.evaluate(
        (v) => {
          document.documentElement.dataset['evaMotion'] = v
        },
        on ? 'on' : 'off',
      ),
    write(): void {
      fs.mkdirSync(PROOF, { recursive: true })
      fs.writeFileSync(path.join(PROOF, 'cpu.json'), JSON.stringify({ pids, samples }, null, 2))
    },
  }
}

/** Astra's start card at rest with motion off and on, researching (magnifier), and hidden. */
async function measureCard(app: ElectronApplication, shell: Page, cpu: CpuSampler): Promise<void> {
  await shell.locator(sel('sidebar-agent-astra')).click()
  const card = shell.locator(`${sel('agent-start-astra')} ${sel('agent-portrait-astra')}`)
  await expect(card).toHaveAttribute('data-state', 'idle', { timeout: 8_000 })
  await cpu.motion(false)
  await cpu.sample('astra card idle, motion off')
  await cpu.motion(true)
  await cpu.sample('astra card idle, motion on')
  const astra: HostSession = {
    id: 'astra-1',
    status: 'working',
    kind: 'assistant',
    assistant: 'astra',
  }
  host.upsert({ ...astra, statusDetail: 'web_search' })
  await expect(card).toHaveAttribute('data-state', 'researching')
  await cpu.sample('astra card researching (magnifier), motion on')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.hide())
  await cpu.sample('astra card researching, window hidden')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.showInactive())
  host.upsert({ ...astra, status: 'idle', statusDetail: '' })
}
