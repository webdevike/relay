// The ticket page's activity against a stand-in Relay host with `tickets` and `tickets.writes`
// (fixture e2e/fixtures/tickets/ENG-9101.json): the Linear description and a comment show their
// images at their `w=` widths; a comment goes prepare -> exact-text confirm -> one commit and is
// shown once; a refusal keeps the draft and says why; an @Astra message is a private ask in
// Relay and sends no gate write at all. No network: Linear only exists as the fake host's fixture.
//
//   pnpm build && pnpm e2e:run e2e/ticket-activity.spec.ts --retries 0 --max-failures 1
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { makeEvaFixture } from './helpers/eva-fixture'

let host: FakeRelayHost

const test = base.extend({
  launchEnv: async ({}, use) => {
    const fx = makeEvaFixture()
    // Astra is a registry assistant, so a private ask starts her item session (fake omp).
    const assistants = path.join(fx.env.EVAOS_EVA_ROOT!, '.omp/assistant')
    fs.mkdirSync(path.join(assistants, 'agents/astra'), { recursive: true })
    fs.writeFileSync(path.join(assistants, 'agents/astra/prime.md'), 'You are Astra.\n')
    fs.writeFileSync(
      path.join(assistants, 'agents.json'),
      JSON.stringify({
        agents: [{ id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' }],
      }),
    )
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-ticket-activity-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', TICKETS_FEATURE, TICKETS_WRITES_FEATURE]
    // Wide images, so a `w=` cap is what sizes them.
    for (const [drop, color] of [
      ['/drops/ticket-desc/tok', '0x3b82f6'],
      ['/drops/ticket-comment/tok', '0x22c55e'],
    ] as const) {
      const out = path.join(root, `${color}.png`)
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=600x200`,
        '-frames:v',
        '1',
        out,
      ])
      host.serveFile(drop, fs.readFileSync(out), 'image/png')
    }
    await use({ ...fx.env, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
    fx.cleanup()
  },
})

test.use({ startOnChat: false })

const SHOTS = path.join(__dirname, '..', 'test-results', 'ticket-activity')
const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Op = { kind: string; opId?: string; mutation?: { kind: string; body?: string } }
const writes = (): Op[] => host.mutations.map((m) => m.cmd as Op)

test('ticket activity: images at width, gated post, refusal, private @Astra', async ({
  app,
  shell,
}) => {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1280, 900))
  await shell.evaluate(() => (window as unknown as Shell).__evaosShell.openPlace('ticket:ENG-9101'))
  const activity = shell.locator(sel('ticket-activity'))
  await expect(activity).toBeVisible({ timeout: 30_000 })

  // Images: the description's at 140 px, the comment's at 90 px (their `w=` titles).
  const descImg = shell.locator(`${sel('ticket-description')} img`)
  await expect(descImg).toBeVisible({ timeout: 20_000 })
  await expect(descImg).toHaveAttribute('style', /max-width: min\(140px, 100%\)/)
  expect((await descImg.boundingBox())!.width).toBeLessThanOrEqual(140)
  const commentImg = activity.locator(`[data-comment-id="c-pal"] img`)
  await expect(commentImg).toBeVisible({ timeout: 20_000 })
  await expect(commentImg).toHaveAttribute('style', /max-width: min\(90px, 100%\)/)
  expect((await commentImg.boundingBox())!.width).toBeLessThanOrEqual(90)
  // `:tada:` shows as the emoji.
  await expect(activity.locator('[data-comment-id="c-mine"]')).toContainText('Looks right 🎉')
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, 'images.png') })

  // Post: prepare, the exact text to confirm, one commit, shown once.
  const composer = shell.locator(sel('ticket-composer'))
  await composer.fill('Ship it today')
  await shell.locator(sel('ticket-composer-send')).click()
  await expect(shell.locator(sel('review-confirm-text'))).toHaveText('Ship it today')
  expect(writes().map((w) => w.kind)).toEqual(['prepare'])
  await shell.locator(sel('review-confirm-post')).click()
  const bodies = activity.locator(sel('ticket-comment-body'))
  await expect(bodies.filter({ hasText: 'Ship it today' })).toHaveCount(1)
  const commits = writes().filter((w) => w.kind === 'commit')
  expect(commits).toHaveLength(1)
  expect(commits[0]!.mutation).toMatchObject({ kind: 'comment', body: 'Ship it today' })
  await expect(composer).toHaveValue('')

  // A refusal: nothing is shown as posted, the draft stays, the reason shows.
  host.refuseNext('writesOff')
  await composer.fill('Second thought')
  await shell.locator(sel('ticket-composer-send')).click()
  await expect(shell.locator(sel('mutation-notice'))).toContainText('Refused: writesOff')
  await expect(composer).toHaveValue('Second thought')
  await expect(bodies.filter({ hasText: 'Second thought' })).toHaveCount(0)
  expect(writes().filter((w) => w.kind === 'commit')).toHaveLength(1)
  await shell.locator(sel('mutation-notice')).getByRole('button', { name: 'Dismiss' }).click()

  // @Astra: "Only you" before send, then a private thread and not one gate write.
  const before = host.mutations.length
  await composer.fill('@Astra what is left here?')
  await expect(shell.locator(sel('composer-private'))).toContainText('Only you')
  await shell.locator(sel('ticket-composer-send')).click()
  // The private thread sits in the activity, then the screenshot of the whole page.
  await expect(shell.locator(sel('review-astra-question')).first()).toContainText(
    '@Astra what is left here?',
  )
  // The private ask came back (the box clears only then): still no gate write, no confirm.
  await expect(composer).toHaveValue('', { timeout: 20_000 })
  expect(host.mutations.length).toBe(before)
  await expect(shell.locator(sel('review-confirm-text'))).toHaveCount(0)
  fs.mkdirSync(SHOTS, { recursive: true })
  await shell.screenshot({ path: path.join(SHOTS, 'activity.png') })
})
