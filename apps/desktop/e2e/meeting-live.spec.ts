import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { MEETING_PROOF_DIR } from './helpers/meeting-proof'
import { EVA_FIXTURE_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// A meeting lives in the chat of the assistant it is routed to: a one-row card ("Meeting in
// progress · <title>", live dot, ticking elapsed) above Astra's composer; a click opens it beside
// the chat as a Meeting tab (Now: the key moments the host found and the shared screen's
// snapshots as they arrive; an Ask menu that posts into the chat as Isaac); when the host routes it elsewhere the card follows; once the notes are written
// the card reads "Meeting ended" with Summary. A fake Relay host that runs Meetings pushes it all.
// meeting-panel.spec.ts covers the panel itself.

const ID = '6f1c2a90-4b7e-4d21-9c3a-0e8d5b7a1f42'
const TITLE = 'Developer Sync: AWS MFA, provisioning failures & release'
const at = (mmss: string): number => {
  const [m, s] = mmss.split(':').map(Number)
  return (m! * 60 + s!) * 1000
}
const LINES: Array<[string, string, string]> = [
  [
    '13:17',
    'Todd',
    "Why don't you guys talk about the release for a minute while I update this for Walker.",
  ],
  ['13:43', 'Chris', "I did the work to move locations around. That's in QA now."],
  [
    '14:09',
    'Todd',
    'Can we get an administration screen that shows every failure, instead of drilling into orders?',
  ],
  ['14:55', 'Isaac', 'Yeah, makes sense.'],
  [
    '16:35',
    'Todd',
    'So we build the visibility and a secure way to remediate it. Isaac, can you take the dashboard?',
  ],
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

const MOMENTS = [
  {
    id: 'km1',
    kind: 'ask',
    atMs: at('14:09'),
    lineId: 'l2',
    speaker: 'Todd',
    text: 'Todd wants an admin screen that shows every failure',
    shot: null,
  },
  {
    id: 'km2',
    kind: 'ask',
    atMs: at('16:35'),
    lineId: 'l4',
    speaker: 'Todd',
    text: 'Isaac to take the failures dashboard',
    shot: null,
  },
]
const SHOT_JPEG = fs.readFileSync(path.join(MEETING_PROOF_DIR, 'shots', '0.jpg'))

let fx: ChatFixture
let host: FakeRelayHost
const startedAt = Date.now() - at('16:40')
const recording = {
  id: ID,
  app: 'Microsoft Teams',
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
  seconds: 1000,
  assistant: 'astra',
}
const ASTRA: HostSession = {
  id: 'astra-1',
  status: 'idle',
  kind: 'assistant',
  assistant: 'astra',
  title: 'Astra',
}
const withMeeting = !process.env.MEETING_BEFORE

const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [
          { id: 'astra', title: 'Astra', scope: 'eCard Systems work', avatar: 'astra-2' },
          { id: 'nova', title: 'Nova', scope: 'Personal', avatar: 'astra-2' },
        ],
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
            content: [
              {
                type: 'text',
                text: "Morning. I'll keep an eye on the 2:00 Developer Sync and pull anything for you out of it.",
              },
            ],
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
    if (withMeeting) {
      host.meetings.recordings = [recording]
      host.meetings.lines.set(ID, lines)
      host.meetings.moments.set(ID, MOMENTS)
    }
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false, reducedMotion: 'reduce' })

const sel = (id: string): string => `[data-testid="${id}"]`

test("a live meeting shows as a card in its assistant's chat and opens beside it", async ({
  app,
  shell,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-astra')).click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Developer Sync', { timeout: 15_000 })

  if (!withMeeting) {
    // Without a meeting (as before this change) the chat shows no meeting UI at all.
    await expect(shell.locator(sel('meeting-card'))).toHaveCount(0)
    await proofShot(app, shell, 'before', { phase: 'live-meeting' })
    return
  }

  // 1. The card: title, live dot, elapsed that ticks.
  const card = shell.locator(sel('meeting-card'))
  await expect(card).toContainText(`Meeting in progress · ${TITLE}`)
  const elapsed = card.locator(sel('meeting-elapsed'))
  const first = await elapsed.textContent()
  await expect(elapsed).not.toHaveText(first ?? '', { timeout: 3000 })
  await proofShot(app, shell, 'after-card', { phase: 'live-meeting' })

  // 2. A click opens the Meeting tab beside the chat: Now lists the key moments, newest first.
  await card.click()
  const tab = shell.locator(sel('meeting-tab'))
  await expect(tab).toBeVisible()
  const moments = tab.locator(sel('meeting-moment'))
  await expect(moments).toHaveCount(2)
  await expect(moments.first()).toContainText('Isaac to take the failures dashboard')
  await expect(moments.first()).toContainText('Asks you · Todd · no reply yet')
  await expect(tab.locator(sel('meeting-tab-when'))).toHaveText(/^1[67] min$/)
  await proofShot(app, shell, 'after-tab', { phase: 'live-meeting' })

  // 3. An Ask menu item lands in Astra's thread as Isaac's words, sent like the composer sends them
  // (`agent.reply` to her session; main adds the device surface line in front, as for any prompt).
  await tab.locator(sel('meeting-ask')).click()
  await shell.locator(sel('meeting-ask-item')).filter({ hasText: 'Catch me up' }).click()
  await expect
    .poll(() =>
      host.commands
        .filter((c) => c.cmd.kind === 'agent.reply' && c.cmd.sessionId === 'astra-1')
        .map((c) => String(c.cmd.text).split('\n').at(-1)),
    )
    .toContain('Catch me up on the meeting')

  // 4. The host finds another key moment, Chris shares his screen and a snapshot arrives: Now
  // puts the moment on top and the snapshot in a strip under the moments.
  host.meetingMoments(ID, [
    ...MOMENTS,
    {
      id: 'km3',
      kind: 'action',
      atMs: at('16:50'),
      lineId: 'l9',
      speaker: 'Chris',
      text: 'Chris pairs on the Flyway script',
      shot: 0,
    },
  ])
  await expect(moments.first()).toContainText('Chris pairs on the Flyway script')
  await expect(moments.first()).toContainText('Action · Chris')
  host.meetingRecording({ ...recording, share: 'sharing' })
  host.meetingShot(
    ID,
    {
      n: 0,
      atMs: at('16:45'),
      src: `/meetings/shots/${ID}/tok/0`,
      w: 1600,
      h: 900,
      line: 'Chris: I can pair on the Flyway script.',
      ocr: 'Release 4.12: ship checklist',
    },
    SHOT_JPEG,
  )
  const thumb = tab.locator(sel('meeting-shot'))
  await expect(thumb).toHaveCount(1)
  await expect(thumb).toContainText('16:45')
  await expect
    .poll(() => thumb.locator('img').evaluate((i) => (i as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await expect(tab.locator(sel('meeting-moment-shot'))).toHaveCount(1)
  await proofShot(app, shell, 'after-tab-shot', { phase: 'live-meeting' })

  // 5. The host routes it to Nova: the card leaves Astra's chat.
  host.meetingRecording({ ...recording, assistant: 'nova' })
  await expect(card).toHaveCount(0)
  host.meetingRecording(recording)
  await expect(card).toBeVisible()

  // 6. The call ends and the notes are written: "Meeting ended" with Summary.
  host.meetings.notes.set(ID, {
    attendees: ['Todd', 'Chris', 'Isaac'],
    attendeesSource: null,
    summary: [
      'Provision failures get an admin view in Administration.',
      'Isaac takes the failures dashboard.',
    ],
    decisions: [],
    questions: [],
    transcript: [],
  })
  host.meetingRecording({ ...recording, stage: 'done', endedAt: startedAt + at('42:00') })
  const ended = shell.locator(sel('meeting-ended'))
  await expect(ended).toContainText(`Meeting ended · 42 min · ${TITLE}`)
  await expect(ended.locator(sel('meeting-summary'))).toHaveText('Summary')
  await expect(tab.locator(sel('meeting-recap'))).toContainText('failures dashboard')
  await expect(tab.locator(sel('meeting-tab-when'))).toHaveText(
    /^\d{1,2}:\d\d( [AP]M)? – \d{1,2}:\d\d [AP]M · 42 min$/,
  )
  await proofShot(app, shell, 'after-ended', { phase: 'live-meeting' })
})
