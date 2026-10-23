// ```ui and ```openui widgets in chat replies: opens a session whose reply carries every widget
// kind from native EvaOS's examples/showcase.md (plus diagram, model, pr and one deliberately bad
// block), checks each renders with its media loaded, that reply buttons and fields send the next
// turn through the composer path, and saves light and dark screenshots to proof/widgets/. A second
// session writes Relay's OpenUI Lang prompt examples and checks they draw through the same widgets,
// including the interactive calculator, whose keys run on the device (proof/widgets/
// openui-calculator.png shows it after 1 2 + 7 =).
//
// Media never comes from the internet: a local server answers the http(s) srcs and stands in for
// the Relay host (its port goes in <configDir>/relay/serve.json), so `/drops/...` srcs resolve
// through the app's relay-media: protocol like they do live.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/widgets.spec.ts
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { writeChatPrefs } from './helpers/chat-fixture'
import { FIXTURES_DIR, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

const OUT = path.join(REPO_ROOT, 'proof', 'widgets')
const TEMPLATE = path.join(FIXTURES_DIR, 'agent-widgets')
const OPENUI_TITLE = 'OpenUI showcase'
const TITLE = 'Widget showcase'
const LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

/** What the stand-in Relay host serves for each drop. */
const DROPS: Record<string, { file: string; type: string }> = {
  '/drops/aud1/tok1': { file: 'clip.wav', type: 'audio/wav' },
  '/drops/vid1/tok1': { file: 'clip.webm', type: 'video/webm' },
  '/drops/ava1/tok1': { file: 'avatar.png', type: 'image/png' },
  '/drops/glb1/tok1': { file: 'cube.glb', type: 'model/gltf-binary' },
}
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg' }

/** Every node kind the reply carries, by the test id its component draws. */
const KINDS = [
  'stat',
  'chart',
  'tickets',
  'compare',
  'gallery',
  'recipe',
  'audio',
  'video',
  'emails',
  'diff',
  'diagram',
  'model',
  'pr',
  'image',
  'text',
  'rows',
  'badge',
  'divider',
  'button',
  'link',
  'table',
  'progress',
  'list',
  'callout',
  'code',
  'quote',
  'avatar',
  'input',
  'stack',
  'grid',
  'tabs',
  'collapse',
]

interface Media {
  port: number
  hits: string[]
}

interface Copy {
  root: string
  log: string
  env: Record<string, string>
}

function copyFixture(port: number): Copy {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-widgets-'))
  const agentDir = path.join(root, 'agent')
  fs.cpSync(TEMPLATE, agentDir, { recursive: true })
  const sessionsDir = path.join(agentDir, 'sessions', '-fixture')
  const minutes = JSON.parse(fs.readFileSync(path.join(agentDir, 'mtimes.json'), 'utf8')) as Record<
    string,
    number
  >
  for (const name of fs.readdirSync(sessionsDir)) {
    const file = path.join(sessionsDir, name)
    const text = fs
      .readFileSync(file, 'utf8')
      .replaceAll('__MEDIA_PORT__', String(port))
      .replaceAll('__MEDIA_DIR__', path.join(agentDir, 'media'))
    fs.writeFileSync(file, text)
    const id = name.slice(name.indexOf('_') + 1, -'.jsonl'.length)
    const when = new Date(Date.now() - minutes[id]! * 60_000)
    fs.utimesSync(file, when, when)
  }
  const log = path.join(root, 'fake-omp.log')
  return {
    root,
    log,
    env: {
      EVAOS_AGENT_DIR: agentDir,
      EVAOS_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_LOG: log,
      FAKE_OMP_DELAY_MS: '5',
    },
  }
}

let copy: Copy
const test = base.extend<{ media: Media }>({
  media: async ({}, use) => {
    const hits: string[] = []
    const dir = path.join(TEMPLATE, 'media')
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/'
      hits.push(url)
      const drop = DROPS[url]
      const name = drop ? drop.file : url.startsWith('/media/') ? path.basename(url) : ''
      const file = path.join(dir, name)
      if (!name || !fs.existsSync(file)) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, {
        'content-type': drop
          ? drop.type
          : (TYPES[path.extname(name)] ?? 'application/octet-stream'),
      })
      fs.createReadStream(file).pipe(res)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    await use({ port: (server.address() as AddressInfo).port, hits })
    await new Promise<void>((r) => server.close(() => r()))
  },
  launchEnv: async ({ media }, use) => {
    copy = copyFixture(media.port)
    await use(copy.env)
    fs.rmSync(copy.root, { recursive: true, force: true })
  },
  configDir: async ({ configDir, media }, use) => {
    writeChatPrefs(configDir, { show_thinking: true, show_tools: true })
    fs.mkdirSync(path.join(configDir, 'relay'), { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'relay', 'serve.json'),
      JSON.stringify({ port: media.port }),
    )
    await use(configDir)
  },
})

test.use({ reducedMotion: 'reduce' })

const frames = (shell: Page): Promise<void> =>
  shell.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )

async function openShowcase(shell: Page, title = TITLE) {
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${title}`) })
    .click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText(title)
  await expect(shell.locator(LOG)).toContainText('Concise Read')
}

/** Prompts fake omp received (FAKE_OMP_LOG), without the `<surface>` line main puts first. */
function prompts(): string[] {
  if (!fs.existsSync(copy.log)) return []
  return fs
    .readFileSync(copy.log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { event: string; detail: { message?: string } })
    .filter((e) => e.event === 'prompt')
    .map((e) => (e.detail.message ?? '').replace(/^<surface>.*<\/surface>\n/, ''))
}

async function scheme(shell: Page, s: 'light' | 'dark') {
  const button = shell.locator(`[data-testid=appearance-${s}]`)
  if (!(await button.isVisible())) await shell.locator('[data-testid=sidebar-back]').click()
  await button.click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
}

/** Screenshots the reply page by page, top to bottom, into proof/widgets/<prefix>-<scheme>-NN.png.
 * Pages overlap by the composer's height, which floats over the bottom of the log. */
async function shootReply(
  app: ElectronApplication,
  shell: Page,
  s: 'light' | 'dark',
  prefix = 'widgets',
) {
  const scroller = shell.locator(LOG).locator(':scope > *').first()
  for (let tries = 0; tries < 4; tries++) {
    await scroller.evaluate((el) => {
      el.scrollTop = 0
    })
    await frames(shell)
  }
  const { pages, step } = await scroller.evaluate((el) => {
    const step = el.clientHeight - 240
    return { pages: Math.ceil((el.scrollHeight - el.clientHeight) / step) + 1, step }
  })
  fs.mkdirSync(OUT, { recursive: true })
  for (let i = 0; i < pages; i++) {
    // Repeated: the virtualized log re-measures rows as they mount and may move the scroll.
    for (let tries = 0; tries < 4; tries++) {
      await scroller.evaluate((el, top) => {
        el.scrollTop = top
      }, i * step)
      await frames(shell)
    }
    await shell.waitForTimeout(150)
    const name = `${prefix}-${s}-${String(i + 1).padStart(2, '0')}`
    const tmp = await proofShot(app, shell, name, { phase: 'widgets' })
    fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
    fs.rmSync(tmp, { force: true })
  }
}

/** Sizes the window's content so screenshots page the same way every run. */
async function sizeWindow(app: ElectronApplication) {
  await app.evaluate(
    (_e, [w, h]) => {
      // Main exposes its window to e2e runs as `__evaosTest.win`; it isn't typed on globalThis.
      const hooks = globalThis as unknown as {
        __evaosTest: { win: { setContentSize(w: number, h: number): void } }
      }
      hooks.__evaosTest.win.setContentSize(w, h)
    },
    [1280, 900] as const,
  )
}

test('every widget kind renders inline, media loads, and replies send the next turn', async ({
  app,
  shell,
  media,
}) => {
  test.setTimeout(180_000)
  await sizeWindow(app)
  await openShowcase(shell)
  const log = shell.locator(LOG)

  for (const kind of KINDS) {
    await expect(log.locator(`[data-testid=widget-${kind}]`).first(), kind).toBeAttached()
  }
  await expect(log.locator('[data-testid=widget-frame][data-card]')).toHaveCount(2)
  await expect(log.locator('[data-testid=widget-stats-row]')).toHaveCount(1)
  // The timeline lives on the second tab.
  await log.getByRole('tab', { name: 'History' }).click()
  await expect(log.locator('[data-testid=widget-timeline]')).toBeAttached()
  await expect(log.getByText('Contract agreed')).toBeAttached()
  // Exactly the one deliberately bad block falls back; the mermaid fence stays plain code.
  await expect(log.getByText("Widget couldn't render")).toHaveCount(1)
  await expect(log.locator('[data-testid=code-block]').filter({ hasText: 'sparkle' })).toHaveCount(
    1,
  )
  await expect(
    log.locator('[data-testid=code-block]').filter({ hasText: 'flowchart TD' }),
  ).toHaveCount(1)

  // Media arrives over relay-media: from a local file, an http URL and a Relay drop.
  const loaded = (selector: string) =>
    log
      .locator(`${selector} img`)
      .first()
      .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
  for (const kind of ['compare', 'gallery', 'image', 'diagram']) {
    await expect.poll(() => loaded(`[data-testid=widget-${kind}]`), { message: kind }).toBe(true)
  }
  await expect.poll(() => log.locator('[data-testid=widget-avatar] img').first().count()).toBe(1)
  await expect
    .poll(() =>
      log
        .locator('audio')
        .first()
        .evaluate((a: HTMLAudioElement) => Number.isFinite(a.duration)),
    )
    .toBe(true)
  await expect
    .poll(() =>
      log
        .locator('video')
        .first()
        .evaluate((v: HTMLVideoElement) => v.readyState),
    )
    .toBeGreaterThan(0)
  await expect(log.locator('[data-testid=widget-model] [data-state]')).toHaveAttribute(
    'data-state',
    'ready',
    { timeout: 20_000 },
  )
  for (const drop of Object.keys(DROPS)) expect(media.hits, drop).toContain(drop)

  const panel = shell.locator('[data-testid=panel-toggle]:visible').first()
  if ((await panel.getAttribute('aria-pressed')) === 'true') await panel.click()
  await expect(panel).toHaveAttribute('aria-pressed', 'false')
  fs.rmSync(OUT, { recursive: true, force: true })
  await scheme(shell, 'light')
  await shootReply(app, shell, 'light')
  await scheme(shell, 'dark')
  await shootReply(app, shell, 'dark')

  // A reply button sends its text as Isaac's next turn, through the composer's send.
  const approve = log.getByRole('button', { name: 'Approve ENG-5533' })
  await approve.scrollIntoViewIfNeeded()
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect.poll(prompts, { timeout: 20_000 }).toContain('approve ENG-5533')
  // The turn shows in the log as Isaac's bubble (the log is virtualized: go to its end first).
  const bubble = log.locator('.eva-bubble', { hasText: 'approve ENG-5533' })
  await expect
    .poll(async () => {
      await log
        .locator(':scope > *')
        .first()
        .evaluate((el) => {
          el.scrollTop = el.scrollHeight
        })
      return bubble.count()
    })
    .toBeGreaterThan(0)
  await expect(shell.getByTestId('composer-input')).toHaveValue('')

  // The input field fills its template, sends, then says Sent.
  const field = shell.locator(LOG).getByLabel('New name')
  await field.scrollIntoViewIfNeeded()
  await field.fill('Atlas')
  await shell.locator(LOG).getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(shell.locator(LOG).getByTestId('widget-input-sent')).toHaveText('Sent')
  await expect.poll(prompts, { timeout: 20_000 }).toContain('rename the project to Atlas')
})

test('OpenUI Lang blocks draw through the same widgets, and a bad one falls back', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await sizeWindow(app)
  await openShowcase(shell, OPENUI_TITLE)
  const log = shell.locator(LOG)

  // One widget root per good block, in reply order, none left partial once the fences closed.
  const roots = log.locator('[data-testid=widget]')
  await expect(roots).toHaveCount(5)
  expect(await roots.evaluateAll((els) => els.map((el) => el.getAttribute('data-widget')))).toEqual(
    ['card', 'tickets', 'card', 'chart', 'card'],
  )
  await expect(log.locator('[data-testid=widget][data-partial]')).toHaveCount(0)
  await expect(log.locator('[data-testid=widget-frame][data-card]')).toHaveCount(3)
  await expect(log.locator('[data-testid=widget-stat]')).toHaveCount(2)
  for (const kind of [
    'rows',
    'badge',
    'divider',
    'tickets',
    'callout',
    'table',
    'progress',
    'button',
    'chart',
  ]) {
    await expect(log.locator(`[data-testid=widget-${kind}]`).first(), kind).toBeAttached()
  }
  // Tickets is a carousel: the first ticket shows, with the args after a null in place.
  await expect(log.getByText("Merged; waiting on Steve's QA on dev before closing.")).toBeVisible()
  await expect(log.getByText('2d ago')).toBeVisible()
  // Only the deliberately bad block falls back, showing its OpenUI source.
  await expect(log.getByText("Widget couldn't render")).toHaveCount(1)
  await expect(
    log.locator('[data-testid=code-block]').filter({ hasText: 'root = Sparkle(' }),
  ).toHaveCount(1)

  // The calculator's keys run on the device: 1 2 + 7 = shows 19 and sends no turn.
  const calc = roots.nth(4)
  const display = calc.getByTestId('widget-text')
  await calc.scrollIntoViewIfNeeded()
  await expect(display).toHaveText('0')
  for (const key of ['1', '2', '+', '7', '='])
    await calc.getByRole('button', { name: key, exact: true }).click()
  await expect(display).toHaveText('19')
  expect(prompts()).toEqual([])
  fs.mkdirSync(OUT, { recursive: true })
  await calc.screenshot({ path: path.join(OUT, 'openui-calculator.png') })

  const panel = shell.locator('[data-testid=panel-toggle]:visible').first()
  if ((await panel.getAttribute('aria-pressed')) === 'true') await panel.click()
  await expect(panel).toHaveAttribute('aria-pressed', 'false')
  await scheme(shell, 'light')
  await shootReply(app, shell, 'light', 'openui')
  await scheme(shell, 'dark')
  await shootReply(app, shell, 'dark', 'openui')

  // An @ToAssistant button sends its text as Isaac's next turn.
  const nudge = log.getByRole('button', { name: 'Nudge Noah' })
  await nudge.scrollIntoViewIfNeeded()
  await expect(nudge).toBeEnabled()
  await nudge.click()
  await expect.poll(prompts, { timeout: 20_000 }).toContain('nudge Noah on ENG-6211')
})
