import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { REVIEWS_ACTIONS_FEATURE } from '@relay/protocol'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'

// The PR page against a fake Relay Host (`reviews.req` from fixtures/reviews, its PR from
// fixtures/reviews/pr.json with `actions` facts): the same PrView from a ticket's PR route and from
// Reviews; Merge now (never auto-merge) confirmed with its head SHA is one gate `prPrepare` and one
// `prCommit` bound to that head; a refusal shows the reason and writes nothing; the folded sidebar
// is kept; a host without `reviews.actions` shows no merge or re-run and gets no PR write.
// No GitHub, Linear or Claude.
//
//   pnpm build && pnpm e2e:run e2e/pr-page.spec.ts --retries 0 --max-failures 1

const FIXTURES = path.join(__dirname, 'fixtures/reviews')
const PR = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'pr.json'), 'utf8')) as {
  repo: string
  number: number
  title: string
  url: string
  headSha: string
  updatedAt: number
}
const NOW = '2026-11-27T18:00:00Z'
const TICKET_PR = `ticket:ENG-9001/pr/${PR.repo}/${PR.number}`

let host: FakeRelayHost

const test = base.extend<{ actions: boolean }>({
  actions: [true, { option: true }],
  launchEnv: async ({ configDir, actions }, use) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-pr-page-')))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    if (actions) host.features.push(REVIEWS_ACTIONS_FEATURE)
    host.serveReviews(FIXTURES)
    // The queue lists the fixture PR; every `pr` read answers it with its actions facts.
    host.reviews.set('pr', { pr: PR })
    host.reviews.set('queue', {
      queue: {
        items: [
          {
            url: PR.url,
            ref: { kind: 'github', repo: PR.repo, number: PR.number },
            title: PR.title,
            actor: 'todd',
            reason: 'review_requested',
            label: 'Review requested',
            updatedAt: PR.updatedAt,
            unread: true,
            draft: false,
            group: 'needs',
          },
        ],
        done: {},
        sources: {
          github: { loading: false, error: null, fetchedAt: PR.updatedAt },
          linear: { loading: false, error: null, fetchedAt: PR.updatedAt },
          slack: { loading: false, error: null, fetchedAt: PR.updatedAt },
        },
      },
    })
    // Remote mode, already paired: this app's config names the host, the host knows its secret.
    const authority = new URL(host.origin).host
    const secretHex = randomBytes(32).toString('hex')
    fs.writeFileSync(
      path.join(configDir, 'relay-remote.json'),
      JSON.stringify({ host: authority, paired: { id: authority, secretHex } }),
      { mode: 0o600 },
    )
    fs.writeFileSync(
      path.join(relayDir, 'devices.json'),
      JSON.stringify({
        [`relay-desktop-${os.hostname()}`]: { secretHex, name: 'Relay Desktop', pairedAt: 1 },
      }),
      { mode: 0o600 },
    )
    await use({ EVAOS_NOW: NOW })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
type Shell = { __evaosShell: { openPlace(page: string): void } }
type Write = { kind: string; opId?: string; approvalId?: string; mutation: Record<string, unknown> }
const writes = (): Write[] => host.prMutations.map((m) => m.cmd as Write)

const uiPrefs = (dir: string): Record<string, unknown> => {
  try {
    const layout = JSON.parse(fs.readFileSync(path.join(dir, 'layout.json'), 'utf8')) as {
      ui?: Record<string, unknown>
    }
    return layout.ui ?? {}
  } catch {
    return {}
  }
}

async function openTicketPr(shell: Page): Promise<void> {
  await shell.evaluate((p) => (window as unknown as Shell).__evaosShell.openPlace(p), TICKET_PR)
  const page = shell.locator(sel('ticket-pr-page'))
  await expect(page.locator(sel('review-detail'))).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(sel('review-head-id'))).toHaveText(`api#${PR.number}`)
}

async function openFromReviews(shell: Page): Promise<void> {
  await shell.locator(sel('nav-reviews')).click()
  const queue = shell.locator(sel('review-queue'))
  await queue.getByText('For me', { exact: true }).click()
  const row = queue.locator(sel(`review-row-${PR.number}`))
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(shell.locator(`${sel('reviews-page')} ${sel('review-detail')}`)).toBeVisible({
    timeout: 30_000,
  })
}

test('one PrView from a ticket and from Reviews; merge bound to the head; refusal; kept fold', async ({
  app,
  shell,
  configDir,
}) => {
  test.setTimeout(150_000)
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
  await shell.clock.setFixedTime(new Date(NOW))

  // From the ticket's PR route: tabs, the sidebar with status, merge box and checks by run.
  await openTicketPr(shell)
  for (const t of ['guide', 'diff', 'comments'])
    await expect(shell.locator(sel(`review-tab-${t}`))).toBeVisible()
  await expect(shell.locator(sel('review-conversation'))).toContainText('Looks right to me.')
  const rail = shell.locator(sel('review-rail'))
  await expect(rail.locator(sel('pr-status-line'))).toContainText('Blocked')
  await expect(rail.locator(sel('pr-check-rerun'))).toHaveCount(1)
  await expect(rail.locator(sel('pr-merge-start'))).toHaveText('Merge now')

  // Merge: the confirm names the head; one prepare, one commit, same head.
  await rail.locator(sel('pr-merge-start')).click()
  await expect(shell.locator(sel('pr-merge-Head'))).toHaveText(PR.headSha.slice(0, 7))
  await expect(shell.locator(sel('pr-merge-Base'))).toHaveText('main')
  expect(writes()).toHaveLength(0)
  await shell.locator(sel('pr-merge-confirm')).click()
  await expect.poll(() => writes().length, { timeout: 15_000 }).toBe(2)
  await expect(rail.locator(sel('pr-merge-note'))).toHaveText('Merged.')
  const [prepare, commit, ...rest] = writes()
  expect(rest).toHaveLength(0)
  expect(prepare).toMatchObject({
    kind: 'prPrepare',
    mutation: { kind: 'merge', repo: PR.repo, number: PR.number, expectHead: PR.headSha },
  })
  expect(commit).toMatchObject({
    kind: 'prCommit',
    approvalId: 'pr-approval-1',
    mutation: prepare!.mutation,
  })
  expect(commit!.opId).toMatch(/^[0-9a-f-]{36}$/)
  expect(JSON.stringify(writes())).not.toContain('admin')

  // Fold the sidebar: the strip says the same, and the choice is kept.
  await shell.locator(sel('pr-sidebar-toggle')).click()
  await expect(shell.locator(sel('review-rail'))).toHaveCount(0)
  await expect.poll(() => uiPrefs(configDir)['reviews.prSidebar']).toBe(false)

  // From Reviews: the same view, still folded; the strip tells the status.
  await openFromReviews(shell)
  await expect(shell.locator(sel('review-rail'))).toHaveCount(0)
  await expect(shell.locator(sel('pr-strip-line'))).toContainText('Blocked')
  await shell.locator(sel('pr-sidebar-toggle')).click()
  await expect.poll(() => uiPrefs(configDir)['reviews.prSidebar']).toBe(true)

  // A refusal: the reason shows, the gate's prepare is the only op, nothing is committed.
  host.refuseNextPr('writesOff')
  const before = writes().length
  await shell.locator(sel('pr-merge-start')).click()
  await shell.locator(sel('pr-merge-confirm')).click()
  await expect(shell.locator(sel('pr-merge-note'))).toContainText('Refused: writesOff')
  expect(
    writes()
      .slice(before)
      .map((w) => w.kind),
  ).toEqual(['prPrepare'])

  // A reaction is a desired-state write, no confirm.
  await shell.locator(sel('pr-reaction')).first().click()
  await expect.poll(() => writes().at(-1)?.mutation['kind']).toBe('react')
  expect(writes().at(-1)).toMatchObject({
    kind: 'prCommit',
    mutation: { target: { kind: 'prBody' }, emoji: 'hooray', on: true },
  })
})

test.describe('a host without reviews.actions', () => {
  test.use({ actions: false })

  test('hides merge and re-run, and gets no PR write', async ({ app, shell }) => {
    test.setTimeout(120_000)
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1440, 900))
    await openTicketPr(shell)
    const rail = shell.locator(sel('review-rail'))
    await expect(rail.locator(sel('pr-status-line'))).toBeVisible()
    await expect(rail.locator(sel('pr-check'))).not.toHaveCount(0)
    await expect(shell.locator(sel('pr-merge'))).toHaveCount(0)
    await expect(shell.locator(sel('pr-check-rerun'))).toHaveCount(0)
    await expect(shell.locator(sel('pr-request-review'))).toHaveCount(0)
    await expect(shell.locator(sel('pr-react-add'))).toHaveCount(0)
    // A reaction chip is read-only here.
    await expect(shell.locator(sel('pr-reaction')).first()).toBeDisabled()
    expect(host.prMutations).toHaveLength(0)
    expect(host.reviewOps.filter((o) => o.kind === 'prPrepare' || o.kind === 'prCommit')).toEqual(
      [],
    )
  })
})
