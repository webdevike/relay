// Inline comments and private assistant asks on the ticket page against a stand-in Relay host with
// `tickets` and `tickets.writes` (fixture e2e/fixtures/tickets/ENG-9101.json): selecting
// description text offers Comment and Quote; Comment goes prepare -> exact-text confirm -> one
// commit carrying `documentContentId`, `quotedText` and the Relay-only anchor context, and the
// thread shows anchored (an amber highlight on the words). An @Astra question in that thread is a
// private ask to her item session (fake omp) and sends no gate write at all. No network.
//
//   pnpm build && pnpm e2e:run e2e/ticket-inline.spec.ts --retries 0 --max-failures 1
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { makeEvaFixture } from './helpers/eva-fixture'

let host: FakeRelayHost
let ompLog = ''

const test = base.extend({
  launchEnv: async ({}, use) => {
    const fx = makeEvaFixture()
    // Astra and Nova are registry assistants: a private ask starts her own item session (fake omp).
    const assistants = path.join(fx.env.EVAOS_EVA_ROOT!, '.omp/assistant')
    for (const id of ['astra', 'nova']) {
      fs.mkdirSync(path.join(assistants, `agents/${id}`), { recursive: true })
      fs.writeFileSync(path.join(assistants, `agents/${id}/prime.md`), `You are ${id}.\n`)
    }
    fs.writeFileSync(
      path.join(assistants, 'agents.json'),
      JSON.stringify({
        agents: [
          { id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' },
          { id: 'nova', title: 'Nova', scope: 'Product', avatar: 'nova-1' },
        ],
      }),
    )
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-ticket-inline-'))
    ompLog = path.join(root, 'fake-omp.log')
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', TICKETS_FEATURE, TICKETS_WRITES_FEATURE]
    // The fixture's description and comment images (a 1x1 PNG each), so nothing 404s.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    for (const drop of ['/drops/ticket-desc/tok', '/drops/ticket-comment/tok'])
      host.serveFile(drop, png, 'image/png')
    await use({
      ...fx.env,
      EVAOS_RELAY_DIR: relayDir,
      FAKE_OMP_LOG: ompLog,
      FAKE_OMP_DELAY_MS: '5',
    })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
    fx.cleanup()
  },
})

test.use({ startOnChat: false })

const SHOTS = path.join(__dirname, '..', 'test-results', 'ticket-inline')
const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Mutation = {
  kind: string
  documentContentId?: string
  quotedText?: string
  anchor?: { prefix: string; suffix: string }
  body?: string
}
type Op = { kind: string; mutation?: Mutation }
const writes = (): Op[] => host.mutations.map((m) => m.cmd as Op)

/** The fake omp's prompts so far (each private ask that reached a session). */
const prompts = (): string[] =>
  fs.existsSync(ompLog)
    ? fs
        .readFileSync(ompLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { event: string; detail: { message?: string } })
        .filter((e) => e.event === 'prompt')
        .map((e) => e.detail.message ?? '')
    : []

test('inline comment: select, confirm, one commit, anchored; @Astra in it stays private', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1280, 900))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('ticket:ENG-9101'))
  const description = shell.locator(sel('ticket-description'))
  await expect(description).toContainText('The flow, as drawn', { timeout: 30_000 })

  // Select "flow, as drawn" in the rendered description: the toolbar offers Comment and Quote.
  await shell.evaluate(() => {
    const body = document.querySelector('[data-testid="ticket-description"] [data-inline-body]')!
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf('flow, as drawn')
      if (at < 0) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + 'flow, as drawn'.length)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(r)
      return
    }
    throw new Error('no description text')
  })
  await expect(shell.locator(sel('selection-toolbar'))).toBeVisible()
  await expect(shell.locator(sel('selection-quote'))).toBeVisible()
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, 'selection.png') })
  await shell.locator(sel('selection-comment')).click()

  // The box opens at the words; the post asks for the exact text first.
  const box = shell.locator(sel('inline-composer'))
  await box.fill('Which flow is this?')
  await shell.locator(sel('inline-composer-send')).click()
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText('Which flow is this?')
  await expect(shell.locator(sel('review-confirm-note'))).toContainText('On “flow, as drawn”')
  expect(writes().map((w) => w.kind)).toEqual(['prepare'])
  await shell.locator(sel('review-confirm-post')).click()

  // One commit, on the description's document, with the quote and where it sat.
  await expect.poll(() => writes().filter((w) => w.kind === 'commit').length).toBe(1)
  const commit = writes().find((w) => w.kind === 'commit')!
  expect(commit.mutation).toMatchObject({
    kind: 'comment',
    documentContentId: 'doc-issue-9101',
    quotedText: 'flow, as drawn',
    body: 'Which flow is this?',
    anchor: { prefix: 'The', suffix: ':' },
  })

  // Anchored: an amber highlight over the words, and the thread opens from it.
  const highlight = shell.locator(sel('inline-highlight')).first()
  await expect(highlight).toBeVisible()
  const hl = (await highlight.boundingBox())!
  expect(hl.width).toBeGreaterThan(20)
  await shell.screenshot({ path: path.join(SHOTS, 'anchored.png') })
  await highlight.focus()
  await shell.keyboard.press('Enter')
  const pop = shell.locator(sel('inline-thread-popover'))
  await expect(pop.locator(sel('ticket-comment-body'))).toContainText('Which flow is this?')
  await expect(pop.locator('blockquote')).toContainText('flow, as drawn')

  // @Astra in the thread: "Only you", then her private session gets it with the thread; no gate write.
  const before = host.mutations.length
  await pop.getByRole('button', { name: 'Reply' }).first().click()
  const reply = pop.locator(sel('ticket-reply-box'))
  await reply.fill('@Astra what does this flow cover?')
  await expect(pop.locator(sel('composer-private'))).toContainText('Only you')
  await pop.locator(sel('ticket-reply-box-send')).click()
  await expect
    .poll(() => prompts().find((p) => p.includes('what does this flow cover?')) ?? '', {
      timeout: 20_000,
    })
    .toContain('On the description text: "flow, as drawn"')
  await expect(pop.locator(sel('assistant-reply'))).toHaveAttribute('data-agent', 'astra')
  await expect(pop.locator(sel('review-astra-question')).first()).toContainText(
    '@Astra what does this flow cover?',
  )
  expect(host.mutations.length).toBe(before)
  await expect(shell.locator(sel('review-confirm-text'))).toHaveCount(0)
  await shell.screenshot({ path: path.join(SHOTS, 'private-ask.png') })
})
