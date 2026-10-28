// Chat visual bench: opens the gallery session (fixtures/agent-gallery) and screenshots every chat
// row kind, card, strip and composer state into proof/chat-visual/.
// Screenshots only: nothing here asserts how the UI should look.
//
//   source scripts/env.sh
//   pnpm -C apps/desktop exec electron-vite build
//   pnpm -C apps/desktop exec playwright test e2e/chat-visual.spec.ts
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as base, expect } from './fixtures'
import { writeChatPrefs } from './helpers/chat-fixture'
import { FIXTURES_DIR, REPO_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

const OUT = path.join(REPO_ROOT, 'proof', 'chat-visual')
const TEMPLATE = path.join(FIXTURES_DIR, 'agent-gallery')
const STEM = '2026-10-20T09-00-00-000Z_chat-gallery'
const TITLE = 'Chat gallery: Relay invoice export'
const LAST_USER_LINE = 'Try again please.'

type Scheme = 'light' | 'dark'
type Spot = 'top' | 'middle' | 'bottom'
const SCHEMES: Scheme[] = ['light', 'dark']
const SPOTS: Spot[] = ['top', 'middle', 'bottom']
const VIEWPORTS = [
  { name: '1280x800', width: 1280, height: 800, panel: false },
  { name: '1440x900-panel', width: 1440, height: 900, panel: true },
  { name: '900x800', width: 900, height: 800, panel: false },
] as const

const CHAT_LOG = '[data-testid=chat-pane] [data-testid=chat-log]'

interface Hooks {
  dropNextBatch(paneId: string): void
  openInPane(paneId: string, file: string): void
  sendFromPane(paneId: string, text: string): Promise<void>
  stats(paneId: string): { pid: number | null }
}
type MainGlobal = {
  __evaosTest: { win: { setContentSize(w: number, h: number): void }; hooks: { chat: Hooks } }
}
type ShellHooks = {
  __evaosShell: { openPlace(page: string, newTab?: boolean, extra?: object): void }
}

// ---------- fixture: a tmp copy of the gallery agent dir, never the repo copy ----------

interface GalleryCopy {
  root: string
  file: string
  env: Record<string, string>
}

function copyGallery(): GalleryCopy {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-chat-visual-'))
  const agentDir = path.join(root, 'agent')
  fs.cpSync(TEMPLATE, agentDir, { recursive: true })
  const sessionsDir = path.join(agentDir, 'sessions', '-fixture')
  const file = path.join(sessionsDir, `${STEM}.jsonl`)
  const minutes = JSON.parse(fs.readFileSync(path.join(agentDir, 'mtimes.json'), 'utf8')) as Record<
    string,
    number
  >
  const now = Date.now()
  for (const [key, ago] of Object.entries(minutes)) {
    const sub = key.split('/')[1]
    const target = sub ? path.join(sessionsDir, STEM, `${sub}.jsonl`) : file
    const when = new Date(now - ago * 60_000)
    fs.utimesSync(target, when, when)
  }
  return {
    root,
    file,
    env: {
      EVAOS_AGENT_DIR: agentDir,
      EVAOS_SESSIONS_DIR: sessionsDir,
      FAKE_OMP_SESSIONS_DIR: sessionsDir,
      // About 16 s of streaming per normal prompt: long enough to capture mid-reply states.
      FAKE_OMP_RECORDING: 'long-turn',
      FAKE_OMP_DELAY_MS: '40',
    },
  }
}

let gallery: GalleryCopy
const test = base.extend<{ chatPrefs: Record<string, unknown> }>({
  chatPrefs: [{ show_thinking: true, show_tools: true }, { option: true }],
  launchEnv: async ({}, use) => {
    gallery = copyGallery()
    await use(gallery.env)
    fs.rmSync(gallery.root, { recursive: true, force: true })
  },
  configDir: async ({ configDir, chatPrefs }, use) => {
    writeChatPrefs(configDir, chatPrefs)
    await use(configDir)
  },
})

test.use({ reducedMotion: 'reduce' })

// ---------- capture ----------

const shots = new Map<string, string>()

const frames = (shell: Page): Promise<void> =>
  shell.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )

async function shot(app: ElectronApplication, shell: Page, name: string, what: string) {
  await frames(shell)
  const tmp = await proofShot(app, shell, name, { phase: 'chat-visual' })
  fs.mkdirSync(OUT, { recursive: true })
  fs.copyFileSync(tmp, path.join(OUT, `${name}.png`))
  fs.rmSync(tmp, { force: true })
  shots.set(`${name}.png`, what)
}

const ROW = /^\| \[([^\]]+)\]\([^)]+\) \| (.*) \|$/

/** Merges this run's shots into index.md, so running one test keeps the other entries. */
test.afterAll(() => {
  if (shots.size === 0) return
  const index = path.join(OUT, 'index.md')
  const all = new Map<string, string>()
  if (fs.existsSync(index)) {
    for (const line of fs.readFileSync(index, 'utf8').split('\n')) {
      const m = ROW.exec(line)
      if (m && !m[1]!.startsWith('native/') && fs.existsSync(path.join(OUT, m[1]!)))
        all.set(m[1]!, m[2]!)
    }
  }
  for (const [k, v] of shots) all.set(k, v)
  const nativeDir = path.join(OUT, 'native')
  const native = fs.existsSync(nativeDir)
    ? fs.readdirSync(nativeDir).filter((f) => f.endsWith('.png'))
    : []
  const lines = [
    '# Chat visual bench',
    '',
    'Screenshots of the chat view rendering the gallery session',
    '(`fixtures/agent-gallery`), written by `apps/desktop/e2e/chat-visual.spec.ts`.',
    'Rerun from the repo root:',
    '',
    '```sh',
    'source scripts/env.sh',
    'pnpm -C apps/desktop exec electron-vite build',
    'pnpm -C apps/desktop exec playwright test e2e/chat-visual.spec.ts',
    '```',
    '',
    'Unless a name says otherwise: Settings > Chat has Show thinking and Show tool details on,',
    'the tool panes are hidden, and motion is off.',
    '',
    '| File | State |',
    '| --- | --- |',
    ...[...all.keys()].sort().map((k) => `| [${k}](${k}) | ${all.get(k)} |`),
  ]
  if (native.length > 0) {
    lines.push(
      '',
      '## Native EvaOS reference',
      '',
      '| File | State |',
      '| --- | --- |',
      ...native.map(
        (f) =>
          `| [native/${f}](native/${f}) | The running native EvaOS app (Rust), a window screenshot for comparison |`,
      ),
    )
  }
  fs.writeFileSync(index, lines.join('\n') + '\n')
})

// ---------- app driving ----------

async function resize(app: ElectronApplication, shell: Page, width: number, height: number) {
  await app.evaluate(
    (_e, [w, h]) => (globalThis as unknown as MainGlobal).__evaosTest.win.setContentSize(w, h),
    [width, height] as const,
  )
  await expect
    .poll(() => shell.evaluate(() => `${window.innerWidth}x${window.innerHeight}`))
    .toBe(`${width}x${height}`)
}

async function panel(shell: Page, open: boolean) {
  const toggle = shell.locator('[data-testid=panel-toggle]:visible').first()
  if ((await toggle.getAttribute('aria-pressed')) !== String(open)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(open))
}

/** The appearance switch sits on the sidebar root level. */
async function scheme(shell: Page, s: Scheme) {
  const button = shell.locator(`[data-testid=appearance-${s}]`)
  if (!(await button.isVisible())) await shell.locator('[data-testid=sidebar-back]').click()
  await button.click()
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', s)
}

async function openGallery(shell: Page) {
  await shell.getByTestId('nav-chat').click()
  await shell
    .getByTestId('chat-tree')
    .getByRole('link', { name: new RegExp(`^${TITLE}`) })
    .click()
  await expect(shell.locator('[data-testid=chat-header]')).toContainText(TITLE)
  // The chat may already be open and scrolled away from its virtualized last rows.
  await scrollLog(shell, CHAT_LOG, 'bottom')
  await expect(shell.locator(CHAT_LOG)).toContainText(LAST_USER_LINE)
}

/** Places the virtualized log; repeated because row heights are measured as rows mount. */
async function scrollLog(shell: Page, log: string, spot: Spot | number) {
  for (let i = 0; i < 4; i++) {
    await shell.evaluate(
      ([sel, at]) => {
        const el = document.querySelector(sel)!.firstElementChild as HTMLElement
        const max = el.scrollHeight - el.clientHeight
        const f = at === 'top' ? 0 : at === 'middle' ? 0.5 : at === 'bottom' ? 1 : (at as number)
        el.scrollTop = Math.round(max * f)
      },
      [log, spot] as const,
    )
    await frames(shell)
  }
}

/**
 * Expands every collapsed thinking and tool row inside the visible part of the log. DOM clicks,
 * so nothing scrolls a toggle into view and the log stays where it was placed.
 */
async function expandVisible(shell: Page, log: string) {
  await shell.evaluate((sel) => {
    const root = document.querySelector(sel)!
    const view = root.getBoundingClientRect()
    for (const b of root.querySelectorAll<HTMLButtonElement>(
      'button.eva-tool-toggle[aria-expanded=false]',
    )) {
      const r = b.getBoundingClientRect()
      if (r.bottom > view.top && r.top < view.bottom) b.click()
    }
  }, log)
  await frames(shell)
}

/** Scrolls the log until `selector` is mounted inside it. */
async function scrollTo(shell: Page, log: string, selector: string) {
  for (let f = 0; f <= 1; f += 0.05) {
    await scrollLog(shell, log, f)
    if (await shell.locator(`${log} ${selector}`).first().isVisible()) return
  }
  throw new Error(`never mounted: ${selector}`)
}

async function send(shell: Page, text: string) {
  const box = shell.locator('[data-testid=chat-pane] [data-testid=composer-input]')
  await box.fill(text)
  await box.press('Enter')
}

const dot = (shell: Page) =>
  shell.locator('[data-testid=chat-header] [aria-label="Eva is replying"]')

/**
 * The reply is over and fake omp has left its replay (it sleeps one frame delay after the last
 * frame; a prompt sent before then is queued as a steer instead of starting a turn).
 */
async function settled(shell: Page) {
  await expect(dot(shell)).toHaveCount(0, { timeout: 60_000 })
  await shell.waitForTimeout(400)
}

/** Dispatches a DOM event carrying files on the chat composer (never OS input). */
const fire = (
  shell: Page,
  type: 'paste' | 'dragenter' | 'dragleave' | 'drop',
  files: Array<{ name: string; mime: string; b64?: string; text?: string }>,
): Promise<void> =>
  shell.evaluate(
    ({ type, files }) => {
      const dt = new DataTransfer()
      for (const f of files) {
        const bytes = f.b64
          ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(f.text ?? '')
        dt.items.add(new File([bytes], f.name, { type: f.mime }))
      }
      const pane = document.querySelector('[data-testid=chat-pane]')!
      const target =
        type === 'paste'
          ? pane.querySelector('[data-testid=composer-input]')!
          : pane.querySelector('[data-testid=composer]')!
      const ev =
        type === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true })
      target.dispatchEvent(ev)
    },
    { type, files },
  )

const blobPng = (): string => {
  const dir = path.join(TEMPLATE, 'blobs')
  return fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!)).toString('base64')
}

async function blur(shell: Page) {
  await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

// ---------- tests ----------

test('gallery transcript: light and dark, three window sizes, top, middle and bottom', async ({
  app,
  shell,
}) => {
  test.setTimeout(240_000)
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  await expect(shell.locator('html')).toHaveAttribute('data-eva-motion', 'off')
  for (const s of SCHEMES) {
    await resize(app, shell, 1280, 800)
    await panel(shell, false)
    await scheme(shell, s)
    await openGallery(shell)
    for (const v of VIEWPORTS) {
      await resize(app, shell, v.width, v.height)
      await panel(shell, v.panel)
      for (const spot of SPOTS) {
        await scrollLog(shell, CHAT_LOG, spot)
        await shot(
          app,
          shell,
          `gallery-${s}-${v.name}-${spot}`,
          `Gallery chat, ${s}, ${v.width}x${v.height}${v.panel ? ' with the tool panes shown' : ''}, transcript scrolled to the ${spot}${spot === 'bottom' ? ' (header shows Saved session)' : ' (Jump to latest pill)'}`,
        )
      }
    }
  }
})

test('gallery rows expanded and the image viewer', async ({ app, shell }) => {
  test.setTimeout(180_000)
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  for (const s of SCHEMES) {
    await resize(app, shell, 1280, 800)
    await panel(shell, false)
    await scheme(shell, s)
    await openGallery(shell)
    for (const spot of SPOTS) {
      await scrollLog(shell, CHAT_LOG, spot)
      await expandVisible(shell, CHAT_LOG)
      // Expanded rows grow the log, so the bottom moves.
      if (spot === 'bottom') await scrollLog(shell, CHAT_LOG, spot)
      await shot(
        app,
        shell,
        `expanded-${s}-1280x800-${spot}`,
        `Gallery, ${s}, every visible folded tool run expanded, transcript at the ${spot}`,
      )
    }
    await scrollTo(shell, CHAT_LOG, '.eva-turn-user .eva-chat-image img')
    await shot(
      app,
      shell,
      `images-${s}-1280x800-user-thumbnails`,
      `Gallery, ${s}: user message with a blob store image and an inline image, then the browse tool row with its screenshot`,
    )
    await shell.locator(`${CHAT_LOG} .eva-turn-user .eva-chat-image`).first().click()
    await expect(shell.getByRole('dialog')).toBeVisible()
    await shot(
      app,
      shell,
      `images-${s}-1280x800-viewer`,
      `Image viewer opened on a chat image, ${s}`,
    )
    await shell.keyboard.press('Escape')
    await expect(shell.getByRole('dialog')).toHaveCount(0)
  }
})

test('tool calls: verbose blocks, then folded runs expanded', async ({ app, shell }) => {
  test.setTimeout(120_000)
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  for (const s of SCHEMES) {
    await resize(app, shell, 1280, 800)
    await panel(shell, false)
    await scheme(shell, s)
    await openGallery(shell)
    await scrollTo(shell, CHAT_LOG, '[data-testid=tool-block]')
    await shell.locator(`${CHAT_LOG} [data-testid=tool-block]`).first().scrollIntoViewIfNeeded()
    await frames(shell)
    await shot(
      app,
      shell,
      `tools-${s}-1280x800-verbose`,
      `Show tool details on, ${s}: each call's header, input and clipped output`,
    )
  }
})

test('composer: focused with text, image attached, drop overlay, notice', async ({
  app,
  shell,
}) => {
  test.setTimeout(120_000)
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  const composer = shell.locator('[data-testid=chat-pane] [data-testid=composer]')
  const box = shell.locator('[data-testid=chat-pane] [data-testid=composer-input]')
  for (const s of SCHEMES) {
    await resize(app, shell, 1280, 800)
    await panel(shell, false)
    await scheme(shell, s)
    await openGallery(shell)
    await box.focus()
    await box.fill(
      'Apply the same fix to the eCard export.\nAdd a regression test that checks the final row, then show me the diff.',
    )
    await shot(
      app,
      shell,
      `composer-${s}-focused-text`,
      `Composer focused with two lines of text, ${s}`,
    )
    await fire(shell, 'paste', [{ name: 'export.png', mime: 'image/png', b64: blobPng() }])
    await expect(composer.locator('[data-testid=composer-chip]')).toHaveCount(1)
    await shot(
      app,
      shell,
      `composer-${s}-image-attached`,
      `Composer with text and one pasted image chip, ${s}`,
    )
    await fire(shell, 'dragenter', [{ name: 'b.png', mime: 'image/png', b64: blobPng() }])
    await expect(composer).toContainText('Drop images to attach')
    await shot(
      app,
      shell,
      `composer-${s}-drop-overlay`,
      `Composer while an image is dragged over it, ${s}`,
    )
    await fire(shell, 'drop', [{ name: 'notes.txt', mime: 'text/plain', text: 'hi' }])
    await expect(composer).toContainText('Only images can be attached.')
    await shot(
      app,
      shell,
      `composer-${s}-notice`,
      `Composer notice after dropping a text file, ${s}`,
    )
    await composer.locator('[aria-label="Remove image 1"]').click()
    await box.fill('')
    await blur(shell)
  }
})

test('new chat empty state', async ({ app, shell }) => {
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  for (const s of SCHEMES) {
    await resize(app, shell, 1280, 800)
    await panel(shell, false)
    await scheme(shell, s)
    await shell.getByTestId('nav-chat').click()
    await shell.getByTestId('chat-new').click()
    await expect(shell.locator('[data-testid=chat-header]')).toContainText('New chat')
    await expect(shell.locator('.eva-chat-empty')).toBeVisible()
    await blur(shell)
    await shot(app, shell, `new-chat-${s}-1280x800`, `New chat empty state, ${s}`)
    await resize(app, shell, 900, 800)
    await shot(app, shell, `new-chat-${s}-900x800`, `New chat empty state at 900 px, ${s}`)
  }
})

for (const s of SCHEMES) {
  test(`live omp states (${s}): streaming, strips, pills, cards, dead card, error, reconnecting`, async ({
    app,
    shell,
  }) => {
    test.setTimeout(240_000)
    await shell.emulateMedia({ reducedMotion: 'reduce' })
    await resize(app, shell, 1280, 800)
    await panel(shell, false)
    await scheme(shell, s)
    await openGallery(shell)
    const log = shell.locator(CHAT_LOG)
    const pane = shell.locator('[data-testid=chat-pane]')

    // Streaming: the reply, Stop, the jobs strip (omp now runs) and the subagent chips.
    await send(shell, 'Apply the same fix to the eCard export please.')
    await expect(dot(shell)).toBeVisible()
    await expect(pane.locator('[data-testid=jobs-strip]')).toBeVisible()
    await expect(log.locator('[data-role=assistant]').last()).toContainText('Foxes hunt at dusk')
    await blur(shell)
    await shot(
      app,
      shell,
      `live-${s}-streaming`,
      `Eva replying: streaming dot, Stop button, jobs strip and subagent chips, ${s}`,
    )

    // Released while output arrives: the New reply pill.
    await scrollLog(shell, CHAT_LOG, 'middle')
    await expect(pane.locator('[data-testid=pill-new-reply]')).toBeVisible()
    await shot(
      app,
      shell,
      `live-${s}-new-reply-pill`,
      `Scrolled up while Eva streams: New reply pill, ${s}`,
    )
    await pane.locator('[data-testid=pill-new-reply]').click()

    // The jobs strip shows while this app's omp runs; the chips come from the session folder.
    await pane.locator('[data-testid=jobs-strip] button').first().click()
    await expect(pane.locator('[data-testid=jobs-row]')).toHaveCount(1)
    await shot(app, shell, `live-${s}-jobs-strip-open`, `Jobs strip expanded while omp runs, ${s}`)
    await pane.locator('[data-testid=subagent-chip-ReviewCsvWriter]').click()
    await expect(shell.locator('[data-testid=subagent-transcript]')).toBeVisible()
    await shot(
      app,
      shell,
      `live-${s}-subagent-panel`,
      `Running subagent transcript in a tool pane tab, ${s}`,
    )
    // Closing its tab drops the transcript; the tool panes hide again for the next shots.
    await shell.locator('[data-testid^="pane-tab-close-subagent:"]').click()
    await expect(shell.locator('[data-testid=subagent-transcript]')).toHaveCount(0)
    await panel(shell, false)
    await settled(shell)
    await shot(
      app,
      shell,
      `live-${s}-after-reply`,
      `Reply finished, omp still running (no Saved session pill), ${s}`,
    )

    // Cards above the composer.
    const card = pane.locator('[data-testid=pending-dialog]')
    const cards: Array<{ kw: string; what: string; answer: () => Promise<void> }> = [
      {
        kw: '[ask]',
        what: 'Ask card, one question with four numbered options',
        answer: () => card.getByRole('radio', { name: /SQLite/ }).click(),
      },
      {
        kw: '[ask-multi]',
        what: 'Ask card, two questions, the second multi choice',
        answer: async () => {
          await card.getByRole('radio', { name: /Postgres/ }).click()
          await card.getByRole('checkbox', { name: /Search/ }).click()
          await card.getByRole('button', { name: 'Send answer' }).click()
        },
      },
      {
        kw: '[select]',
        what: 'Select card (extension UI) with option details',
        answer: () => card.getByRole('radio', { name: /Beta/ }).click(),
      },
      {
        kw: '[confirm]',
        what: 'Confirm card',
        answer: () => card.getByRole('button', { name: 'Confirm' }).click(),
      },
      {
        kw: '[input]',
        what: 'Input card',
        answer: async () => {
          await card.getByRole('textbox').fill('Isaac')
          await card.getByRole('button', { name: 'Send answer' }).click()
        },
      },
    ]
    for (const c of cards) {
      await send(shell, `${c.kw} question`)
      await expect(card).toBeVisible()
      await blur(shell)
      await shot(app, shell, `card-${s}-${c.kw.slice(1, -1)}`, `${c.what}, ${s}`)
      await c.answer()
      await expect(card).toHaveCount(0)
      await expect(log).toContainText('Answer received')
      await settled(shell)
    }

    // An editor card, then omp dies: the card is dimmed and the error banner shows.
    await send(shell, '[editor] notes')
    await expect(card).toBeVisible()
    await blur(shell)
    await shot(app, shell, `card-${s}-editor`, `Editor card with prefilled text, ${s}`)
    const pid = await app.evaluate(
      () => (globalThis as unknown as MainGlobal).__evaosTest.hooks.chat.stats('pane-1').pid,
    )
    expect(pid).not.toBeNull()
    process.kill(pid!, 'SIGKILL')
    await expect(pane.locator('[data-testid=chat-error]')).toBeVisible()
    await expect(card).toHaveAttribute('data-dead', 'true')
    await shot(
      app,
      shell,
      `card-${s}-dead-and-error-banner`,
      `omp exited unexpectedly: dead question card and the error banner, ${s}`,
    )

    // A lost batch: Reconnecting to the stream.
    await app.evaluate(() =>
      (globalThis as unknown as MainGlobal).__evaosTest.hooks.chat.dropNextBatch('pane-1'),
    )
    await send(shell, 'Say hello')
    await expect(shell.locator('[data-testid=chat-header]')).toContainText(
      'Reconnecting to the stream.',
    )
    await shot(
      app,
      shell,
      `live-${s}-reconnecting`,
      `Header while the stream resyncs (Reconnecting to the stream.), ${s}`,
    )
    await settled(shell)

    // Released with no new output: the Jump to latest pill. Re-pin first with whichever pill a
    // resync left behind, so only the scroll below releases the log.
    const pills = pane.locator('[data-testid=pill-jump], [data-testid=pill-new-reply]')
    if ((await pills.count()) > 0) await pills.first().click()
    await expect(pills).toHaveCount(0)
    await scrollLog(shell, CHAT_LOG, 'middle')
    await expect(pane.locator('[data-testid=pill-jump]')).toBeVisible()
    await shot(
      app,
      shell,
      `live-${s}-jump-pill`,
      `Scrolled up after the reply: Jump to latest pill, ${s}`,
    )
  })
}

test('owned by another pane and the writer prompt', async ({ app, shell }) => {
  await shell.emulateMedia({ reducedMotion: 'reduce' })
  await resize(app, shell, 1280, 800)
  await panel(shell, false)
  await app.evaluate(async (_e, file) => {
    const hooks = (globalThis as unknown as MainGlobal).__evaosTest.hooks.chat
    hooks.openInPane('pane-2', file)
    await hooks.sendFromPane('pane-2', 'first')
  }, gallery.file)
  await openGallery(shell)
  await expect(shell.locator('[data-testid=chat-header]')).toContainText('Owned by another pane')
  await shot(app, shell, 'owned-light-header', 'Header when another pane runs omp for this chat')
  await send(shell, 'second')
  await expect(shell.getByText('Chat is open elsewhere')).toBeVisible()
  await shot(
    app,
    shell,
    'owned-light-writer-prompt',
    'Writer prompt: confirm before writing into a chat another pane owns',
  )
  await shell.getByRole('button', { name: "Don't send" }).click()
})

test.describe('Settings > Chat toggles off', () => {
  test.use({ chatPrefs: { show_thinking: false, show_tools: false } })

  test('settings page and the folded transcript', async ({ app, shell }) => {
    test.setTimeout(120_000)
    await shell.emulateMedia({ reducedMotion: 'reduce' })
    for (const s of SCHEMES) {
      await resize(app, shell, 1280, 800)
      await panel(shell, false)
      await scheme(shell, s)
      await shell.evaluate(() =>
        (window as unknown as ShellHooks).__evaosShell.openPlace('settings', false, {
          settingsSection: 'Chat',
        }),
      )
      await expect(shell.locator('[data-testid=settings-show-tools]')).not.toBeChecked()
      await expect(shell.locator('[data-testid=settings-show-thinking]')).not.toBeChecked()
      await shot(
        app,
        shell,
        `settings-chat-${s}-toggles-off`,
        `Settings > Chat with Show thinking and Show tool details off, ${s}`,
      )
      await openGallery(shell)
      await expect(shell.locator(`${CHAT_LOG} [data-role=thinking]`)).toHaveCount(0)
      for (const spot of SPOTS) {
        await scrollLog(shell, CHAT_LOG, spot)
        await shot(
          app,
          shell,
          `toggles-off-${s}-1280x800-${spot}`,
          `Gallery with thinking hidden and tool runs folded into "Used N tools" lines, ${s}, transcript at the ${spot}`,
        )
      }
      await scrollTo(shell, CHAT_LOG, '[data-testid=tool-group]')
      await expandVisible(shell, CHAT_LOG)
      await shot(
        app,
        shell,
        `toggles-off-${s}-1280x800-tool-run-open`,
        `Folded tool runs, ${s}, the visible runs opened to their calls`,
      )
    }
  })
})

test.describe('Settings > Chat defaults', () => {
  test.use({ chatPrefs: { show_thinking: false, show_tools: false } })

  test('gallery with the default switches (thinking off, tool details off)', async ({
    app,
    shell,
  }) => {
    await shell.emulateMedia({ reducedMotion: 'reduce' })
    for (const s of SCHEMES) {
      await resize(app, shell, 1280, 800)
      await panel(shell, false)
      await scheme(shell, s)
      await openGallery(shell)
      for (const spot of ['middle', 'bottom'] as const) {
        await scrollLog(shell, CHAT_LOG, spot)
        await shot(
          app,
          shell,
          `defaults-${s}-1280x800-${spot}`,
          `Gallery with the default switches (thinking hidden, tool runs folded), ${s}, transcript at the ${spot}`,
        )
      }
    }
  })
})
