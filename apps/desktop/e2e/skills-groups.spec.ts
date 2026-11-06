import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import * as Y from 'yjs'
import type { SkillDetail, SkillList, SkillRow } from '@evaos/contract'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { SkillRooms } from './helpers/skill-room'

// The Skills page's families and origin, and its detail panel's scrolling, against the fake host.
//   - Skills from one package (or one vendor, or a shared name prefix) are one group row that opens
//     onto its members; groups add up uses, sort by their totals, open under a search, and stay
//     open across a reload of the page.
//   - Origin says omp, Claude or Both and filters like Source.
//   - The panel under the tabs is one scroll container on every tab; the Editor grows to its
//     content instead of scrolling inside itself.
//
// Proof run: SKILLS_DUMP=<dir>/list.json (a real list with packages and origins) serves that list
// and SKILLS_SHOTS=<dir> takes the proof screenshots of it.
const dump = process.env.SKILLS_DUMP
const shots = process.env.SKILLS_SHOTS

const DAY = 86_400_000
const now = Date.now()
const omp = {
  key: 'native:project',
  label: 'Project',
  dir: '~/Eva/.omp/skills/x',
  file: '/x/SKILL.md',
}
const agents = {
  key: 'agents:user',
  label: 'Agents',
  dir: '~/.agents/skills/x',
  file: '/y/SKILL.md',
}
const claude = {
  key: 'claude:project',
  label: 'Claude project',
  dir: '~/Eva/.claude/skills/x',
  file: '/z/SKILL.md',
}

function row(name: string, over: Partial<SkillRow>): SkillRow {
  return {
    name,
    description: `The ${name} skill.`,
    source: omp,
    also: [],
    updatedAt: now - 5 * DAY,
    usedBy: ['nova'],
    disabled: false,
    lastUsedAt: null,
    uses: 0,
    origin: 'omp',
    ...over,
  }
}

const ROWS: SkillRow[] = [
  row('cloudflare', {
    source: agents,
    package: 'cloudflare/skills',
    uses: 4,
    lastUsedAt: now - 2 * DAY,
  }),
  row('wrangler', {
    source: agents,
    package: 'cloudflare/skills',
    uses: 30,
    lastUsedAt: now - 3_600_000,
  }),
  row('k2', { source: agents, package: 'cloudflare/skills' }),
  row('remotion-docs', {
    source: claude,
    package: 'remotion-dev/skills',
    origin: 'both',
    uses: 2,
    lastUsedAt: now - 9 * DAY,
  }),
  row('remotion-saas', {
    source: claude,
    package: 'remotion-dev/skills',
    origin: 'both',
    uses: 1,
    lastUsedAt: now - 20 * DAY,
  }),
  row('seo-audit', { uses: 7, lastUsedAt: now - DAY }),
  row('keyword-research', { uses: 3, lastUsedAt: now - 4 * DAY }),
  row('canvas', { uses: 12, lastUsedAt: now - 2 * DAY }),
  row('zeta', { source: claude, origin: 'claude', uses: 1, lastUsedAt: now - 30 * DAY }),
  row('long', { uses: 50, lastUsedAt: now - 3_600_000 }),
]

const PARAGRAPHS = 90
const LAST_LINE = `Closing line ${PARAGRAPHS}, the end of the long skill.`

/** A skill document as the host holds it: frontmatter and many paragraphs, so it needs scrolling. */
function longDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.getMap('front').set('name', 'long')
  doc.getMap('front').set('description', 'A skill with a long document.')
  const nodes = Array.from({ length: PARAGRAPHS }, (_, i) => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [
      new Y.XmlText(
        i === PARAGRAPHS - 1
          ? LAST_LINE
          : `Paragraph ${i + 1}. A skill's body is plain markdown that an agent reads.`,
      ),
    ])
    return p
  })
  doc.getXmlFragment('body').insert(0, nodes)
  return doc
}

function detail(r: SkillRow): SkillDetail {
  const many = r.name === 'long'
  return {
    ...r,
    files: many
      ? Array.from({ length: 60 }, (_, i) => ({ path: `refs/file-${i}.md`, size: 800 + i }))
      : [{ path: 'SKILL.md', size: 1200 }],
    profiles: { nova: 'personal' },
    stats: {
      uses: r.uses ?? 0,
      uses7d: 3,
      uses30d: 9,
      lastUsedAt: r.lastUsedAt,
      firstUsedAt: now - 50 * DAY,
      byAgent: many
        ? Array.from({ length: 40 }, (_, i) => ({
            agent: `helper-${i}`,
            kind: 'subagent' as const,
            owner: 'nova',
            uses: 40 - i,
            lastUsedAt: now - i * DAY,
          }))
        : [],
      daily: Array.from({ length: 30 }, (_, i) => i % 4),
    },
  }
}

let host: FakeRelayHost
let root: string

const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-skills-groups-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    const rooms = new SkillRooms()
    rooms.add('long', longDoc())
    host.extra.http = (req, res) => rooms.http(req, res)
    host.extra.upgrade = (req, socket) => rooms.upgrade(req, socket)
    const json = (p: string, v: unknown): void =>
      host.serveFile(p, Buffer.from(JSON.stringify(v)), 'application/json')
    const assistants = [{ id: 'nova', title: 'Nova', profile: 'personal', color: '#7c3aed' }]
    if (dump) {
      const list = JSON.parse(fs.readFileSync(dump, 'utf8')) as SkillList
      json('/skills', list)
      for (const r of list.skills) json(`/skills/${r.name}`, detail(r))
    } else {
      json('/skills', { skills: ROWS, assistants })
      for (const r of ROWS) json(`/skills/${r.name}`, detail(r))
    }
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

test.use({ startOnChat: false })

const rowNames = (shell: Page): Promise<string[]> =>
  shell.$$eval('[data-testid=skills-table] [data-list-row]', (els) =>
    els.map((e) => e.getAttribute('data-skill') ?? e.getAttribute('data-testid') ?? ''),
  )

async function openSkills(app: import('@playwright/test').ElectronApplication, shell: Page) {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1500, 900))
  await shell.locator('[data-testid=nav-skills]').click()
  await expect(shell.locator('[data-testid=skills-table]')).toBeVisible()
}

test('families are group rows: totals, sort, search, remembered open state', async ({
  app,
  shell,
}) => {
  test.skip(!!dump, 'the fixture run only')
  await openSkills(app, shell)
  // Collapsed by default: families are one row each; a skill alone stays a plain row.
  await expect
    .poll(() => rowNames(shell))
    .toEqual([
      'canvas',
      'skill-group-brand:cloudflare',
      'long',
      'skill-group-brand:remotion',
      'skill-group-brand:seo',
      'zeta',
    ])
  const cf = shell.locator('[data-testid="skill-group-brand:cloudflare"]')
  await expect(cf).toContainText('Cloudflare')
  await expect(cf.getByTestId('skill-group-count-brand:cloudflare')).toHaveText('3')
  await expect(cf.locator('svg.tabler-icon-brand-cloudflare')).toBeVisible()
  await expect(shell.getByTestId('skill-uses-brand:cloudflare')).toHaveText('34')
  await expect(shell.getByTestId('skill-uses-brand:remotion')).toHaveText('3')

  // Opening shows the members, indented, under it.
  await cf.click()
  await expect(cf).toHaveAttribute('aria-expanded', 'true')
  await expect
    .poll(() => rowNames(shell))
    .toEqual([
      'canvas',
      'skill-group-brand:cloudflare',
      'cloudflare',
      'k2',
      'wrangler',
      'long',
      'skill-group-brand:remotion',
      'skill-group-brand:seo',
      'zeta',
    ])

  // Uses sorts groups by their total, members inside by their own.
  await shell.getByRole('button', { name: 'Sort by uses' }).click()
  await expect
    .poll(() => rowNames(shell))
    .toEqual([
      'long',
      'skill-group-brand:cloudflare',
      'wrangler',
      'cloudflare',
      'k2',
      'canvas',
      'skill-group-brand:seo',
      'skill-group-brand:remotion',
      'zeta',
    ])
  await shell.getByRole('button', { name: 'Sort by name' }).click()

  // A search opens the groups it matched in, with only the matches, and shuts them again after.
  await shell.getByLabel('Search skills').fill('keyword')
  await expect.poll(() => rowNames(shell)).toEqual(['skill-group-brand:seo', 'keyword-research'])
  await shell.getByLabel('Search skills').fill('')
  await expect(shell.locator('[data-testid="skill-group-brand:seo"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  )

  // What was open is open again after the page is rebuilt.
  await shell.reload()
  await shell.locator('[data-testid=nav-skills]').click()
  await expect(shell.locator('[data-testid="skill-group-brand:cloudflare"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
})

test('Origin says omp, Claude or Both, and filters', async ({ app, shell }) => {
  test.skip(!!dump, 'the fixture run only')
  await openSkills(app, shell)
  await expect(shell.getByTestId('skill-row-canvas').locator('[data-origin=omp]')).toHaveText('omp')
  await expect(shell.getByTestId('skill-row-zeta').locator('[data-origin=claude]')).toHaveText(
    'Claude',
  )
  await expect(
    shell.locator('[data-testid="skill-group-brand:remotion"] [data-origin=both]'),
  ).toHaveText('Both')
  await shell.getByRole('button', { name: /^Origin: All/ }).click()
  await shell.getByRole('menuitem', { name: 'Claude' }).click()
  await expect.poll(() => rowNames(shell)).toEqual(['zeta'])
  await shell.getByRole('button', { name: /^Origin: Claude/ }).click()
  await shell.getByRole('menuitem', { name: 'Both' }).click()
  await expect.poll(() => rowNames(shell)).toEqual(['skill-group-brand:remotion'])
})

test('the panel is one scroll body under pinned tabs on every tab', async ({ app, shell }) => {
  test.skip(!!dump, 'the fixture run only')
  await openSkills(app, shell)
  await shell.getByTestId('skill-row-long').click()
  const panel = shell.getByTestId('skill-panel')
  // The header keeps the name and folder; the description lives in the Editor only.
  await expect(panel.getByTestId('skill-panel-uses')).toBeVisible()
  await expect(panel.getByText('The long skill.', { exact: true })).toHaveCount(0)
  const last = panel.getByText(LAST_LINE)
  await expect(last).toBeAttached()
  const tabs = panel.getByRole('tablist')
  const tabsTop = (await tabs.boundingBox())!.y

  // The last line starts below the fold; a wheel over the body brings it up.
  const body = panel.locator('.eva-skills-tabpanel:visible')
  const box = (await body.boundingBox())!
  expect((await last.boundingBox())!.y).toBeGreaterThan(box.y + box.height)
  await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 40; i++) await shell.mouse.wheel(0, 400)
  await expect
    .poll(async () => {
      const l = (await last.boundingBox())!
      return l.y + l.height <= box.y + box.height + 1 && l.y >= box.y
    })
    .toBe(true)
  // The tabs stayed; the editor itself holds no scroll of its own.
  expect((await tabs.boundingBox())!.y).toBe(tabsTop)
  const nested = await panel
    .locator('.eva-skills-prose, .eva-skills-sheet, .eva-skills-doc')
    .evaluateAll(
      (els) =>
        els.filter(
          (e) => e.scrollHeight > e.clientHeight + 1 && getComputedStyle(e).overflowY !== 'visible',
        ).length,
    )
  expect(nested).toBe(0)

  // Usage and Settings scroll the same way.
  for (const [tab, deep] of [
    ['Usage', 'helper-39'],
    ['Settings', 'refs/file-59.md'],
  ] as const) {
    await panel.getByRole('tab', { name: tab }).click()
    const tabBody = panel.locator('.eva-skills-tabpanel:visible')
    const b = (await tabBody.boundingBox())!
    await shell.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    for (let i = 0; i < 40; i++) await shell.mouse.wheel(0, 400)
    await expect
      .poll(async () => {
        const l = (await panel.getByText(deep, { exact: true }).boundingBox())!
        return l.y + l.height <= b.y + b.height + 1
      })
      .toBe(true)
    expect((await tabs.boundingBox())!.y).toBe(tabsTop)
  }
})

test('proof: groups with the real list', async ({ app, shell }) => {
  test.skip(!dump || !shots, 'proof run only (SKILLS_DUMP and SKILLS_SHOTS)')
  fs.mkdirSync(shots!, { recursive: true })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1600, 1000))
  await shell.locator('[data-testid=nav-skills]').click()
  await expect(shell.locator('[data-testid=skills-table]')).toBeVisible()
  await shell.screenshot({ path: path.join(shots!, 'collapsed.png') })
  await shell.locator('[data-testid="skill-group-brand:cloudflare"]').click()
  await shell.screenshot({ path: path.join(shots!, 'cloudflare-expanded.png') })
  await shell.getByRole('button', { name: /^Origin: All/ }).click()
  await shell.getByRole('menuitem', { name: 'Claude', exact: true }).click()
  await shell.screenshot({ path: path.join(shots!, 'origin-claude.png') })
  await shell.getByRole('button', { name: /^Origin: Claude/ }).click()
  await shell.getByRole('menuitem', { name: 'Both', exact: true }).click()
  await shell.screenshot({ path: path.join(shots!, 'origin-both.png') })
})
