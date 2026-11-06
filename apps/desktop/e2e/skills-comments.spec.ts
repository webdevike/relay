import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { SkillDetail, SkillRow } from '@evaos/contract'
import { test as base, expect } from './fixtures'
import { pickScheme } from './helpers/appearance'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'
import { SkillsTestHost } from './helpers/skills-test-host'

// The Skills editor's comments and agent requests, against the Relay host's own skills code (a
// throwaway host process behind the fake host, helpers/skills-test-host.ts) with a scripted Nova:
//   - selecting text shows the formatting toolbar; its Comment anchors a thread to the text;
//   - the thread persists (host file, reopening the skill) and Nova answers a question in it;
//   - a request makes Nova's caret type a suggestion into the doc, drawn as a diff with Accept and
//     Reject: Reject restores the text exactly, Accept keeps it and only then is SKILL.md unsaved;
//     the file on disk changes on Save alone.
//
// Proof run: SKILLS_COMMENTS_PROOF=<dir> saves screenshots there and a video of the requests.
const PROOF = process.env.SKILLS_COMMENTS_PROOF ?? ''

const SKILL = `---
name: pr-review
description: Review a pull request the way Isaac does.
---

# PR review

Read the whole diff before writing a single comment.

## Rules

- Keep every review comment under three sentences, with the file and line it is about.
- Flag missing tests before style nits.
- Approve only when CI is green.
`
const LONG_RULE =
  'Keep every review comment under three sentences, with the file and line it is about.'
const SHORT_RULE = 'Three sentences per comment, file and line included.'
const ANSWER =
  'A comment written before you have seen the whole change is often wrong by the last file: a helper you asked for already exists, or the bug you flagged is fixed further down.'

const row: SkillRow = {
  name: 'pr-review',
  description: 'Review a pull request the way Isaac does.',
  source: {
    key: 'native:project',
    label: 'Project',
    dir: '~/Eva/.omp/skills/pr-review',
    file: '/x/SKILL.md',
  },
  also: [],
  updatedAt: Date.now() - 86_400_000,
  usedBy: ['nova'],
  disabled: false,
  lastUsedAt: null,
  uses: 0,
  origin: 'omp',
}
const detail: SkillDetail = {
  ...row,
  files: [],
  stats: null,
  profiles: { nova: 'personal' },
} as unknown as SkillDetail

let host: FakeRelayHost
let skills: SkillsTestHost
let root: string

const test = base.extend({
  launchEnv: async ({}, use) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaos-skills-comments-'))
    const relayDir = path.join(root, 'relay')
    // Nova in the registry, so the thread shows her name and face.
    const evaRoot = path.join(root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'astra-2' }],
      }),
    )
    host = await FakeRelayHost.start(relayDir)
    skills = await SkillsTestHost.start('pr-review', SKILL, {
      playbook: [
        { match: '^why', reply: ANSWER, delay: 900 },
        {
          match: 'shorter',
          edit: { find: 'quote', replace: SHORT_RULE },
          reply: 'Shortened it to one line. Accept or reject it above.',
          delay: 700,
        },
      ],
    })
    host.extra.http = (req, res) => skills.http(req, res)
    host.extra.upgrade = (req, socket) => skills.upgrade(req, socket)
    const json = (p: string, v: unknown): void =>
      host.serveFile(p, Buffer.from(JSON.stringify(v)), 'application/json')
    json('/skills', {
      skills: [row],
      assistants: [{ id: 'nova', title: 'Nova', profile: 'personal', color: '#f76707' }],
    })
    json('/skills/pr-review', detail)
    await use({ EVAOS_RELAY_DIR: relayDir, EVAOS_EVA_ROOT: evaRoot })
    skills.close()
    await host.close()
    fs.rmSync(root, { recursive: true, force: true })
  },
})

test.use({ startOnChat: false })

const sel = (id: string): string => `[data-testid=${id}]`

async function shot(shell: Page, name: string, of?: string): Promise<void> {
  if (PROOF === '') return
  fs.mkdirSync(PROOF, { recursive: true })
  const target = shell.locator(of ?? sel('skill-panel'))
  await target.screenshot({ path: path.join(PROOF, `${name}.png`) })
}

/** Selects `phrase` in the document, as a drag over it would. */
async function select(shell: Page, phrase: string): Promise<void> {
  await shell.locator('.eva-skills-prose').getByText(phrase, { exact: false }).first().click()
  await shell.evaluate((p) => {
    const root = document.querySelector('.eva-skills-prose .ProseMirror')
    if (!root) throw new Error('no editor')
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.textContent?.indexOf(p) ?? -1
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(n, at)
      range.setEnd(n, at + p.length)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(range)
      return
    }
    throw new Error(`not in the doc: ${p}`)
  }, phrase)
  await expect(shell.locator(sel('skill-bubble'))).toBeVisible()
}

/** Comments `text` on `phrase` through the toolbar's Comment. */
async function comment(shell: Page, phrase: string, text: string): Promise<void> {
  await select(shell, phrase)
  await shell.locator(sel('skill-tool-comment')).click()
  const field = shell.locator(sel('skill-comment-input'))
  await expect(field).toBeFocused()
  await field.pressSequentially(text, { delay: PROOF === '' ? 0 : 35 })
  await field.press('Enter')
  await expect(shell.locator(sel('skill-thread'))).toBeVisible()
}

/** Records the panel as numbered frames while `run` goes, for the proof video. */
async function recording(shell: Page, run: () => Promise<void>): Promise<void> {
  if (PROOF === '') return run()
  const frames = path.join(PROOF, 'frames')
  fs.rmSync(frames, { recursive: true, force: true })
  fs.mkdirSync(frames, { recursive: true })
  let n = 0
  let on = true
  const loop = (async () => {
    while (on) {
      const started = Date.now()
      await shell
        .locator(sel('skill-panel'))
        .screenshot({ path: path.join(frames, `${String(n++).padStart(5, '0')}.png`) })
        .catch(() => undefined)
      await new Promise((r) => setTimeout(r, Math.max(0, 100 - (Date.now() - started))))
    }
  })()
  try {
    await run()
    await shell.waitForTimeout(1200)
  } finally {
    on = false
    await loop
  }
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '10',
    '-i',
    path.join(frames, '%05d.png'),
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-c:v',
    'libx264',
    '-crf',
    '23',
    '-movflags',
    '+faststart',
    path.join(PROOF, 'request-flow.mp4'),
  ])
  fs.rmSync(frames, { recursive: true, force: true })
}

async function openSkill(app: ElectronApplication, shell: Page): Promise<void> {
  await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]!.setSize(1500, 950))
  await shell.locator(sel('nav-skills')).click()
  await shell.locator(sel('skill-row-pr-review')).click()
  await expect(shell.locator('.eva-skills-prose')).toContainText('Read the whole diff')
}

/** The first rule's text as the document holds it (agents' caret labels left out). */
const ruleText = (shell: Page) =>
  shell
    .locator('.eva-skills-prose li')
    .first()
    .evaluate((li) => {
      const copy = li.cloneNode(true) as HTMLElement
      for (const caret of copy.querySelectorAll('[class^="collaboration-carets"]')) caret.remove()
      return copy.textContent ?? ''
    })

test('comments, questions and requests with live suggestions', async ({ app, shell }) => {
  test.setTimeout(120_000)
  await openSkill(app, shell)
  const disk = (): string => fs.readFileSync(skills.file, 'utf8')

  // The selection toolbar, light and dark.
  await select(shell, 'Read the whole diff before writing a single comment.')
  for (const name of ['Bold', 'Italic', 'Strikethrough', 'Code', 'Link', 'Bulleted list'])
    await expect(shell.getByRole('button', { name, exact: true })).toBeVisible()
  await shot(shell, '1-toolbar-light')
  await pickScheme(shell, 'dark')
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'dark')
  await select(shell, 'Read the whole diff before writing a single comment.')
  await shot(shell, '1-toolbar-dark')
  await pickScheme(shell, 'light')
  await expect(shell.locator('html')).toHaveAttribute('data-resolved', 'light')

  // A question: the thread is anchored to the text, and Nova answers in it.
  await comment(shell, 'Read the whole diff', 'Why the whole diff first?')
  const thread = shell.locator(sel('skill-thread'))
  await expect(thread).toContainText('Why the whole diff first?')
  await expect(thread.locator(sel('skill-thread-assignee'))).toContainText('For Nova')
  await expect(thread.locator(sel('skill-thread-working'))).toContainText('Nova is on it')
  await expect(thread).toContainText(ANSWER)
  await expect(thread.locator(sel('skill-thread-working'))).toHaveCount(0)
  await expect(shell.locator('.eva-doc-comment[data-active=true]')).toHaveText(
    'Read the whole diff',
  )
  await shot(shell, '2-question-answered')

  // The thread persists: the host keeps it in its file, and it is there after reopening the skill.
  await expect
    .poll(() => JSON.stringify(skills.threadsFile()))
    .toContain('Why the whole diff first?')
  await shell.keyboard.press('Escape')
  await expect(thread).toHaveCount(0)
  await shell.locator(sel('skill-panel-close')).click()
  await shell.locator(sel('skill-row-pr-review')).click()
  const highlight = shell.locator('.eva-doc-comment').first()
  await expect(highlight).toHaveText('Read the whole diff')
  await highlight.click()
  await expect(thread).toContainText(ANSWER)
  await shell.keyboard.press('Escape')

  // A request, rejected: Nova's caret types the change as a suggestion; Reject restores the text.
  const original = disk()
  await recording(shell, async () => {
    await comment(shell, LONG_RULE, 'Make this shorter')
    await expect(shell.locator('.collaboration-carets__label')).toContainText('Nova')
    await expect(shell.locator('.eva-doc-del')).toHaveText(LONG_RULE)
    await expect(shell.locator('.eva-doc-ins')).toHaveText(SHORT_RULE)
    await expect(thread.locator(sel('skill-thread-suggestion'))).toContainText(
      'Nova suggested a change',
    )
    await expect(thread).toContainText('Shortened it to one line.')
    await shot(shell, '3-suggestion')
    // Pending, it is not an unsaved edit and never reaches the file.
    await expect(shell.locator(sel('skill-unsaved'))).toHaveCount(0)
    await shell.waitForTimeout(PROOF === '' ? 0 : 900)
    await thread.locator(sel('skill-suggestion-reject')).click()
    await expect(shell.locator('.eva-doc-del')).toHaveCount(0)
    await expect(shell.locator('.eva-doc-ins')).toHaveCount(0)
    expect(await ruleText(shell)).toBe(LONG_RULE)
    await expect(shell.locator(sel('skill-unsaved'))).toHaveCount(0)
    expect(disk()).toBe(original)

    // Asked again, and accepted from the change's own bar: now SKILL.md is unsaved.
    await shell.keyboard.press('Escape')
    await comment(shell, LONG_RULE, 'Shorter please')
    await expect(shell.locator('.eva-doc-ins')).toHaveText(SHORT_RULE)
    await shell.keyboard.press('Escape')
    const bar = shell.locator(sel('skill-suggestion'))
    await expect(bar).toContainText('Nova suggested a change')
    await shot(shell, '4-suggestion-bar')
    await shell.waitForTimeout(PROOF === '' ? 0 : 900)
    await bar.locator(sel('skill-suggestion-accept')).click()
    await expect(shell.locator('.eva-doc-ins')).toHaveCount(0)
    await expect(shell.locator('.eva-doc-del')).toHaveCount(0)
    expect(await ruleText(shell)).toBe(SHORT_RULE)
    await expect(shell.locator(sel('skill-unsaved'))).toBeVisible()
  })
  expect(disk()).toBe(original)
  await shot(shell, '5-accepted-unsaved')

  // Save writes it.
  await shell.locator('.eva-skills-prose .ProseMirror').click()
  await shell.keyboard.press('Meta+s')
  await expect(shell.locator(sel('skill-unsaved'))).toHaveCount(0)
  await expect.poll(disk).toContain(`- ${SHORT_RULE}`)
  expect(disk()).not.toContain(LONG_RULE)
})
