import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// The Meeting panel beside Astra's chat, against a fake Relay host running Meetings: a call long
// enough to overflow the pane, with decisions, actions and questions put to Isaac.

const ID = '6f1c2a90-4b7e-4d21-9c3a-0e8d5b7a1f43'
const TITLE = 'Developer Sync: AWS MFA, provisioning failures & release'
const at = (mmss: string): number => {
  const [m, s] = mmss.split(':').map(Number)
  return (m! * 60 + s!) * 1000
}
const LINES: Array<[string, string, string]> = [
  [
    '9:05',
    'Todd',
    "Why don't you guys talk about the release for a minute while I update this for Walker.",
  ],
  ['10:30', 'Priya', 'Release notes are drafted, they just need the Flyway bit.'],
  ['11:45', 'Todd', 'Walker asked about the AWS bill again.'],
  ['13:10', 'Chris', "I did the work to move locations around. That's in QA now."],
  ['14:20', 'Priya', 'I can look at the staging dry run after lunch.'],
  ['16:00', 'Chris', 'Three tenants hit the provisioning timeout this week.'],
  ['18:30', 'Todd', 'We need a way to see those without opening every order.'],
  [
    '22:02',
    'Todd',
    "Can we get an administration screen that shows every failure? We'll ship the release Thursday if QA is clean.",
  ],
  ['25:00', 'Priya', 'The console accounts still have no MFA.'],
  ['28:15', 'Isaac', 'Yeah, makes sense.'],
  ['31:00', 'Chris', 'Retries help, but they hide the real error.'],
  [
    '35:40',
    'Todd',
    'So we build the visibility and a secure way to remediate it. Isaac, can you take the dashboard?',
  ],
  ['41:00', 'Chris', 'The provisioning failures are all on the same tenant.'],
  ['44:30', 'Priya', 'Staging is green apart from the Flyway step.'],
  ['47:10', 'Todd', 'Walker wants a date for the admin view.'],
  ['51:05', 'Chris', 'I can pair on the Flyway script.'],
  ['53:00', 'Todd', 'Good. Priya, where are we on the MFA ticket?'],
  ['54:00', 'Priya', 'I will open the MFA ticket today. The console accounts are the blocker.'],
  ['55:00', 'Chris', 'Looks like three accounts failed on the same step.'],
  ['56:00', 'Todd', 'Isaac, did you see the failures in the Flyway log?'],
]
const lines = LINES.map(([t, speaker, text], i) => ({
  id: `l${i}`,
  track: speaker === 'Isaac' ? 'mic' : 'app',
  speaker,
  startMs: at(t),
  endMs: at(t) + 4000,
  text,
  final: true,
}))

let fx: ChatFixture
let host: FakeRelayHost
const startedAt = Date.now() - at('56:10')
const recording = {
  id: ID,
  app: 'Teams',
  title: TITLE,
  startedAt,
  endedAt: null,
  device: 'Isaac MacBook',
  stage: 'recording',
  health: 'ok',
  healthDetail: '',
  error: null,
  shadow: false,
  stem: null,
  seconds: 3400,
  assistant: 'astra',
}
const ASTRA: HostSession = {
  id: 'astra-1',
  status: 'idle',
  kind: 'assistant',
  assistant: 'astra',
  title: 'Astra',
}

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [{ id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' }],
      }),
    )
    fs.writeFileSync(
      path.join(fx.sessionsDir, '2026-11-12T09-00-00-000Z_astra-1.jsonl'),
      [
        {
          type: 'session',
          version: 3,
          id: 'astra-1',
          timestamp: new Date().toISOString(),
          cwd: '/',
        },
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          message: { role: 'user', content: 'Hi Astra' },
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: "Morning. I'll keep an eye on the Developer Sync." }],
          },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    host.features = ['render.report', 'meetings']
    host.upsert(ASTRA)
    host.meetings.recordings = [recording]
    host.meetings.lines.set(ID, lines)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false, reducedMotion: 'reduce' })

const sel = (id: string): string => `[data-testid="${id}"]`
const NOTES = {
  attendees: ['Todd', 'Chris', 'Priya', 'Isaac'],
  attendeesSource: null,
  summary: [
    'Release status, an admin view for provisioning failures,',
    'and MFA on AWS console accounts by month end.',
  ],
  decisions: [],
  questions: [],
  transcript: [],
}

const shot = (
  app: Parameters<typeof proofShot>[0],
  shell: Parameters<typeof proofShot>[1],
  name: string,
) => proofShot(app, shell, name, { phase: 'meeting-panel' })

test('the Meeting panel: Now, a transcript that follows, moments, one Ask menu, Summary after', async ({
  app,
  shell,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-astra')).click()
  await shell.locator(sel('meeting-card')).click()
  const tab = shell.locator(sel('meeting-tab'))
  const view = tab.locator(sel('meeting-tab-view'))
  const jumpLive = tab.locator(sel('meeting-jump-live'))
  const gap = () =>
    view.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight))

  // 1. Now: who is speaking and what they just said, what came before, the latest three moments.
  await expect(tab.locator(sel('meeting-tabs')).getByRole('tab')).toHaveText([
    'Now',
    'Transcript',
    'Moments',
  ])
  await expect(tab.locator(sel('meeting-tab-now'))).toHaveAttribute('aria-selected', 'true')
  const speaker = tab.locator(sel('meeting-speaker'))
  await expect(speaker).toContainText('Todd')
  await expect(speaker).toContainText('Isaac, did you see the failures in the Flyway log?')
  await expect(speaker).toContainText(
    'Before that, Chris: Looks like three accounts failed on the same step.',
  )
  await expect(tab.locator('.eva-meeting-tab-meta')).toHaveText(/^Teams·Live·5[67] minEnd meeting$/)
  const moments = tab.locator(sel('meeting-moment'))
  await expect(moments).toHaveCount(3)
  await expect(moments.first()).toContainText(/Todd · (just now|1 min ago), no reply yet/)
  await expect(moments.nth(1)).toContainText('Action · Priya')
  await shot(app, shell, 'after-live-now')

  // 2. Transcript: overflows the pane and follows the newest line as it arrives.
  await tab.locator(sel('meeting-tab-transcript')).click()
  await expect(tab.locator(sel('meeting-row'))).toHaveCount(LINES.length)
  expect(await view.evaluate((el) => el.scrollHeight > el.clientHeight * 1.5)).toBe(true)
  await expect.poll(gap).toBeLessThan(24)
  host.meetingLive(ID, [
    {
      id: 'l20',
      track: 'app',
      speaker: 'Chris',
      startMs: at('57:00'),
      endMs: at('57:04'),
      text: 'I can review the checklist before it goes out.',
      final: true,
    },
  ])
  await expect(tab.locator(sel('meeting-row')).last()).toContainText('review the checklist')
  await expect.poll(gap).toBeLessThan(24)
  await expect(jumpLive).toHaveCount(0)
  await shot(app, shell, 'after-live-transcript')

  // 3. Scrolling up pauses following: Jump to live shows and new lines no longer pull the view.
  await view.evaluate((el) => (el.scrollTop = 0))
  await expect(jumpLive).toBeVisible()
  host.meetingLive(ID, [
    {
      id: 'l21',
      track: 'app',
      speaker: 'Priya',
      startMs: at('58:00'),
      endMs: at('58:04'),
      text: 'Moving on to the release notes.',
      final: true,
    },
  ])
  await expect(tab.locator(sel('meeting-row')).last()).toContainText('release notes')
  expect(await view.evaluate((el) => el.scrollTop)).toBe(0)
  await shot(app, shell, 'after-live-paused')
  await jumpLive.click()
  await expect(jumpLive).toHaveCount(0)
  await expect.poll(gap).toBeLessThan(24)
  // Scrolling back to the bottom by hand resumes following too.
  await view.evaluate((el) => (el.scrollTop = 0))
  await expect(jumpLive).toBeVisible()
  await view.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await expect(jumpLive).toHaveCount(0)

  // 4. A moment jumps to its row in the transcript, a third of the way down, and lights it up.
  await tab.locator(sel('meeting-tab-moments')).click()
  await expect(moments.first()).toContainText('review the checklist')
  await moments.filter({ hasText: 'Isaac, can you take the dashboard?' }).click()
  await expect(tab.locator(sel('meeting-tab-transcript'))).toHaveAttribute('aria-selected', 'true')
  const row = tab.locator('[data-row-id="l11"]')
  await expect(row).toHaveAttribute('data-lit', 'true')
  await expect(jumpLive).toBeVisible()
  const third = await row.evaluate((el) => {
    const v = el.closest('[data-testid="meeting-tab-view"]')!
    return (el.getBoundingClientRect().top - v.getBoundingClientRect().top) / v.clientHeight
  })
  expect(third).toBeGreaterThan(0.2)
  expect(third).toBeLessThan(0.45)
  await shot(app, shell, 'after-moment-jump')
  await expect(row).toHaveAttribute('data-lit', 'false', { timeout: 5000 })

  // 5. One Ask control: its menu posts the item into Astra's chat as Isaac; no answer shows here.
  const ask = tab.locator(sel('meeting-ask'))
  await expect(ask).toHaveText('Ask Astra…')
  const items = shell.locator(sel('meeting-ask-item'))
  await ask.click()
  await expect(items).toHaveText(['Catch me up', 'Draft a reply', 'List actions'])
  await shot(app, shell, 'after-ask-menu')
  await shell.keyboard.press('Escape')
  await expect(items).toHaveCount(0)
  await ask.click()
  await expect(items).toHaveCount(3)
  await tab.locator('.eva-meeting-tab-title').click()
  await expect(items).toHaveCount(0)
  await ask.click()
  await items.filter({ hasText: 'Catch me up' }).click()
  await expect
    .poll(() =>
      host.commands
        .filter((c) => c.cmd.kind === 'agent.reply' && c.cmd.sessionId === 'astra-1')
        .map((c) => String(c.cmd.text).split('\n').at(-1)),
    )
    .toContain('Catch me up on the meeting')
  await expect(items).toHaveCount(0)
  await expect(tab).not.toContainText('Catch me up on the meeting')

  // 6. End meeting stops the recording; once the notes are written Summary leads, For you first.
  await tab.locator(sel('meeting-end')).click()
  await expect.poll(() => host.meetingOps).toContainEqual({ kind: 'stop', id: ID })
  host.meetings.notes.set(ID, NOTES)
  host.meetingRecording({ ...recording, stage: 'done', endedAt: startedAt + at('58:10') })
  await expect(tab.locator(sel('meeting-tabs')).getByRole('tab')).toHaveText([
    'Summary',
    'Transcript',
    'Moments',
  ])
  await expect(tab.locator(sel('meeting-tab-summary'))).toHaveAttribute('aria-selected', 'true')
  const recap = tab.locator(sel('meeting-recap'))
  await expect(recap).toContainText('Release status, an admin view for provisioning failures, and')
  await expect(recap.locator('.eva-meeting-tab-label')).toHaveText([
    'For you',
    'Actions',
    'Decided',
  ])
  await expect(recap.locator(sel('meeting-for-you')).first()).toContainText(
    'Isaac, can you take the dashboard?',
  )
  await expect(tab.locator(sel('meeting-tab-when'))).toHaveText(
    /^\d{1,2}:\d\d( [AP]M)? – \d{1,2}:\d\d [AP]M · 58 min$/,
  )
  await expect(tab.locator(sel('meeting-end'))).toHaveCount(0)
  await expect(ask).toBeVisible()
  await shot(app, shell, 'after-ended-summary')
  await tab.locator(sel('meeting-tab-moments')).click()
  await expect(moments.filter({ hasText: 'Isaac, can you take' })).toContainText(
    'Todd · no reply yet',
  )
  await shot(app, shell, 'after-ended-moments')
})
