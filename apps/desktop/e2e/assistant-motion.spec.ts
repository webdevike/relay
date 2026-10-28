import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'

// An assistant's portrait moves with its thread (@relay/portrait-motion): the start card greets,
// thinks once Start is on its way, and the crumb, tab and sidebar portraits work, talk, finish,
// ask and fail as the thread does. A fake Relay host on a real WebSocket lists the thread and
// streams its reply; the thread file is written like omp writes it. Tests run with motion off, so
// the states are asserted from `data-state`. EVAOS_MOTION_PROOF=<dir> turns motion on, records the
// run as JPEG screencast frames in <dir>/frames and samples the app's CPU into <dir>/cpu.json.
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
test.use({ startOnChat: false, panelOpen: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)
const hold = (shell: Page, ms: number): Promise<void> =>
  PROOF ? shell.waitForTimeout(ms) : Promise.resolve()

/** Nova's thread as Relay lists it. */
const NOVA_THREAD: HostSession = {
  id: 'nova-1',
  status: 'working',
  kind: 'assistant',
  assistant: 'nova',
  title: 'Nova',
}

test("an assistant's portrait greets, thinks, works, talks, finishes, asks and fails with its thread", async ({
  app,
  shell,
}) => {
  test.setTimeout(PROOF ? 240_000 : 60_000)
  await shell.locator(sel('nav-assistants')).click()

  const cpu = PROOF ? await cpuSampler(app, shell) : null
  if (cpu) await measureCard(app, shell, cpu)

  const stopRecording = PROOF ? await record(shell) : null
  // 1. The start card greets as the page opens, then rests.
  await shell.locator(sel('sidebar-agent-nova')).click()
  const card = shell.locator(`${sel('agent-start-nova')} ${sel('agent-portrait-nova')}`)
  const side = shell.locator(sel('sidebar-portrait-nova'))
  await expect(card).toHaveAttribute('data-state', 'hello')
  await expect(card).toHaveAttribute('data-state', 'idle', { timeout: 8_000 })
  await hold(shell, 1_000)

  // 2. Start goes through Relay and Relay lists the thread working: Thinking, the ring turning.
  await shell.locator(sel('start-nova')).click()
  await expect.poll(() => host.kinds()).toContain('assistant.turn')
  host.upsert(NOVA_THREAD)
  await expect(card).toHaveAttribute('data-state', 'thinking')
  await expect(side).toHaveAttribute('data-ring', 'true')
  await hold(shell, 3_000)

  // 3. omp writes the thread and runs a tool: the page is the conversation, and Nova works.
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
              name: 'read',
              arguments: { path: 'memory/todos.md' },
            },
          ],
        },
      }),
    ].join('\n') + '\n',
  )
  host.upsert(NOVA_THREAD)
  const crumb = shell.locator(`${sel('agent-crumb')} ${sel('agent-portrait-nova')}`)
  await expect(crumb).toHaveAttribute('data-state', 'working', { timeout: 10_000 })
  await expect(crumb).toHaveAttribute('data-ring', 'true')
  await hold(shell, 3_000)

  // 4. The tool returns and the reply streams in: Talking.
  await fx.append(
    'nova-1',
    line({
      type: 'message',
      id: 'r1',
      parentId: 'c1',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: '3 open' }],
      },
    }),
  )
  await expect.poll(() => host.subscribed('nova-1')).toBe(true)
  const words =
    'Hi Isaac! You have three open todos today, and the first one is due at noon.'.split(' ')
  for (let i = 1; i <= words.length; i++) {
    host.stream('nova-1', 'm1', words.slice(0, i).join(' '), true)
    if (i === 2) await expect(crumb).toHaveAttribute('data-state', 'talking')
    await hold(shell, 220)
  }
  await expect(crumb).toHaveAttribute('data-state', 'talking')

  // 5. The turn ends well: Done for a moment, then Idle.
  const answer = words.join(' ')
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
  await expect(crumb).toHaveAttribute('data-state', 'done')
  await expect(crumb).toHaveAttribute('data-state', 'idle', { timeout: 5_000 })
  await hold(shell, 1_500)

  // 6. omp's ask tool waits on Isaac (Relay still says working): Confused, an orange dot.
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
  await expect(crumb).toHaveAttribute('data-state', 'confused')
  await expect(side).toHaveAttribute('data-dot', 'orange')
  await hold(shell, 3_500)
  await shell.locator(sel('pending-dialog')).getByRole('radio', { name: /Yes/ }).click()
  await expect(shell.locator(sel('pending-dialog'))).toHaveCount(0)

  // 7. The next turn fails: Error, a red dot.
  host.upsert({ ...NOVA_THREAD, statusDetail: 'bash' })
  await expect(crumb).toHaveAttribute('data-state', 'thinking')
  await hold(shell, 1_500)
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
  await expect(crumb).toHaveAttribute('data-state', 'error')
  await expect(side).toHaveAttribute('data-dot', 'red')
  await hold(shell, 3_500)
  await stopRecording?.()
  if (cpu) {
    // Small portraits only: Nova's crumb, tab and sidebar row (Error: breathing, red dot), then
    // Astra's sidebar ring turning too.
    await cpu.motion(false)
    await cpu.sample('chat page, small portraits, motion off')
    await cpu.motion(true)
    await cpu.sample('chat page, small portraits breathing, motion on')
    host.upsert({ id: 'astra-1', status: 'working', kind: 'assistant', assistant: 'astra' })
    await expect(shell.locator(sel('sidebar-portrait-astra'))).toHaveAttribute('data-ring', 'true')
    await cpu.sample('chat page, small portraits + a sidebar ring, motion on')
    cpu.write()
  }
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

/** Astra's start card at rest with motion off and on, thinking (ring), and with the window hidden. */
async function measureCard(app: ElectronApplication, shell: Page, cpu: CpuSampler): Promise<void> {
  await shell.locator(sel('sidebar-agent-astra')).click()
  const card = shell.locator(`${sel('agent-start-astra')} ${sel('agent-portrait-astra')}`)
  await expect(card).toHaveAttribute('data-state', 'idle', { timeout: 8_000 })
  await cpu.motion(false)
  await cpu.sample('astra card idle, motion off')
  await cpu.motion(true)
  await cpu.sample('astra card idle, motion on')
  host.upsert({ id: 'astra-1', status: 'working', kind: 'assistant', assistant: 'astra' })
  await expect(card).toHaveAttribute('data-state', 'thinking')
  await cpu.sample('astra card thinking (ring), motion on')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.hide())
  await cpu.sample('astra card thinking, window hidden')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.showInactive())
  host.upsert({ id: 'astra-1', status: 'idle', kind: 'assistant', assistant: 'astra' })
}
