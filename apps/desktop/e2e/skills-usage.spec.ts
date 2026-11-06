import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import type { SkillDetail, SkillList, SkillRow } from '@evaos/contract'
import { test as base, expect } from './fixtures'
import { FakeRelayHost } from './helpers/fake-relay-host'

// The Skills page's usage: Uses and Last used columns that sort without changing the default (name),
// never-used skills said quietly, and the Usage tab's counts, 30-day trend and uses by agent, all
// from the host's GET /skills routes (served here by the fake host).
//
// Proof run: SKILLS_DUMP=<dir> (list.json and skills/<name>.json, the real host's answers) and
// SKILLS_SHOTS=<dir> serve those instead and screenshot the table and the busiest skill's Usage tab.
const dump = process.env.SKILLS_DUMP
const shots = process.env.SKILLS_SHOTS

const DAY = 86_400_000
const now = Date.now()
const source = {
  key: 'native:project',
  label: 'Project',
  dir: '~/Eva/.omp/skills',
  file: '/x/SKILL.md',
} as const

function row(name: string, uses: number, lastUsedAt: number | null, updatedAt: number): SkillRow {
  return {
    name,
    description: `The ${name} skill.`,
    source,
    also: [],
    updatedAt,
    usedBy: ['nova'],
    disabled: false,
    lastUsedAt,
    uses,
  }
}

const ROWS = [
  row('canvas', 12, now - 2 * DAY, now - 40 * DAY),
  row('dormant', 0, null, now - 3 * DAY),
  row('work', 40, now - 3_600_000, now - 10 * DAY),
]

function detail(r: SkillRow): SkillDetail {
  const daily = Array.from({ length: 30 }, (_, i) => (r.uses ? (i % 4) + (i > 25 ? 2 : 0) : 0))
  return {
    ...r,
    files: [{ path: 'SKILL.md', size: 1200 }],
    profiles: { nova: 'personal' },
    stats:
      r.uses === 0
        ? {
            uses: 0,
            uses7d: 0,
            uses30d: 0,
            lastUsedAt: null,
            firstUsedAt: null,
            byAgent: [],
            daily: Array(30).fill(0),
          }
        : {
            uses: r.uses ?? 0,
            uses7d: 9,
            uses30d: daily.reduce((a, b) => a + b, 0),
            lastUsedAt: r.lastUsedAt,
            firstUsedAt: now - 50 * DAY,
            byAgent: [
              {
                agent: 'helper-visual',
                kind: 'subagent',
                owner: 'nova',
                uses: 25,
                lastUsedAt: now - DAY,
              },
              {
                agent: 'nova',
                kind: 'assistant',
                owner: 'nova',
                uses: 10,
                lastUsedAt: now - 3_600_000,
              },
              { agent: 'other', kind: 'other', owner: null, uses: 5, lastUsedAt: now - 9 * DAY },
            ],
            daily,
          },
  }
}

let host: FakeRelayHost
let root: string
let busiest = 'work'

const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-skills-'))
    const relayDir = path.join(root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    const json = (p: string, v: unknown): void =>
      host.serveFile(p, Buffer.from(JSON.stringify(v)), 'application/json')
    if (dump) {
      const list = JSON.parse(fs.readFileSync(path.join(dump, 'list.json'), 'utf8')) as SkillList
      host.serveFile('/skills', fs.readFileSync(path.join(dump, 'list.json')), 'application/json')
      for (const f of fs.readdirSync(path.join(dump, 'skills'))) {
        const body = fs.readFileSync(path.join(dump, 'skills', f))
        host.serveFile(`/skills/${f.replace(/\.json$/, '')}`, body, 'application/json')
      }
      busiest = [...list.skills].sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0))[0]!.name
    } else {
      json('/skills', {
        skills: ROWS,
        assistants: [{ id: 'nova', title: 'Nova', profile: 'personal', color: '#7c3aed' }],
      })
      for (const r of ROWS) json(`/skills/${r.name}`, detail(r))
    }
    await use({ EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

test.use({ startOnChat: false })

const names = (shell: Page): Promise<string[]> =>
  shell.$$eval('[data-testid=skills-table] [data-skill]', (els) =>
    els.map((e) => e.getAttribute('data-skill') ?? ''),
  )

test('Uses and Last used sort; never used is said quietly; Usage shows who', async ({
  app,
  shell,
}) => {
  test.skip(!!dump, 'the fixture run only')
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1400, 860))
  await shell.locator('[data-testid=nav-skills]').click()
  await expect(shell.locator('[data-testid=skills-count]')).toHaveText('3 skills, 1 never used')
  // The default sort stays by name.
  await expect.poll(() => names(shell)).toEqual(['canvas', 'dormant', 'work'])
  await expect(shell.locator('[data-testid=skill-uses-work]')).toHaveText('40')
  await expect(shell.locator('[data-testid=skill-row-dormant]')).toContainText('Never')

  await shell.getByRole('button', { name: 'Sort by uses' }).click()
  await expect.poll(() => names(shell)).toEqual(['work', 'canvas', 'dormant'])
  await shell.getByRole('button', { name: 'Sort by uses' }).click()
  await expect.poll(() => names(shell)).toEqual(['dormant', 'canvas', 'work'])
  await shell.getByRole('button', { name: 'Sort by last used' }).click()
  await expect.poll(() => names(shell)).toEqual(['work', 'canvas', 'dormant'])

  await shell.locator('[data-testid=skill-row-work]').click()
  await expect(shell.locator('[data-testid=skill-panel-uses]')).toContainText('40')
  // Beside the panel (which shows the description and folder) the table drops Description and
  // Source, so every other column still fits.
  const table = shell.locator('[data-testid=skills-table]')
  await expect(table.getByText('Description', { exact: true })).toHaveCount(0)
  await expect(shell.getByRole('button', { name: 'Sort by updated' })).toBeInViewport({ ratio: 1 })
  await shell.getByRole('tab', { name: 'Usage' }).click()
  const usage = shell.locator('[data-testid=skill-usage]')
  await expect(usage).toContainText('All time')
  await expect(shell.locator('[data-testid=skill-trend]')).toBeVisible()
  const agents = shell.locator('[data-testid=skill-by-agent]')
  await expect(agents).toContainText('helper-visual')
  await expect(agents).toContainText('25')
  await expect(agents).toContainText('Other')
  if (shots) await shell.screenshot({ path: path.join(shots, 'fixture-usage-tab.png') })

  await shell.locator('[data-testid=skill-row-dormant]').click()
  await shell.getByRole('tab', { name: 'Usage' }).click()
  await expect(shell.locator('[data-testid=skill-usage-never]')).toBeVisible()
})

test('proof: the real numbers from this Mac', async ({ app, shell }) => {
  test.skip(!dump || !shots, 'proof run only (SKILLS_DUMP and SKILLS_SHOTS)')
  fs.mkdirSync(shots!, { recursive: true })
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1600, 1000))
  await shell.locator('[data-testid=nav-skills]').click()
  await expect(shell.locator('[data-testid=skills-count]')).toContainText('never used')
  await shell.screenshot({ path: path.join(shots!, 'table-by-name.png') })
  await shell.getByRole('button', { name: 'Sort by uses' }).click()
  await expect.poll(async () => (await names(shell))[0]).toBe(busiest)
  await shell.screenshot({ path: path.join(shots!, 'table-by-uses.png') })
  await shell.getByRole('button', { name: 'Sort by uses' }).click()
  await shell.screenshot({ path: path.join(shots!, 'table-never-used.png') })
  await shell.getByRole('button', { name: 'Sort by uses' }).click()
  await shell.locator(`[data-testid="skill-row-${busiest}"]`).click()
  await shell.getByRole('tab', { name: 'Usage' }).click()
  await expect(shell.locator('[data-testid=skill-by-agent]')).toBeVisible()
  await shell.screenshot({ path: path.join(shots!, 'usage-tab.png') })
})
