import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost, type HostSession } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'
import { proofShot } from './helpers/proofShot'

// A meeting lives in the chat of the assistant it is routed to: a one-row card ("Meeting in
// progress · <title>", live dot, ticking elapsed) above Astra's composer; a click opens it beside
// the chat as a Meeting tab (speaker, rolling transcript, quick asks that post into the chat as
// Isaac); when the host routes it elsewhere the card follows; once the notes are written the card
// reads "Meeting ended" with Summary. A fake Relay host that runs Meetings pushes it all.

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
  routedByIsaac: false,
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

  // 2. A click opens the Meeting tab beside the chat: speaker and transcript.
  await card.click()
  const tab = shell.locator(sel('meeting-tab'))
  await expect(tab).toBeVisible()
  await expect(tab.locator(sel('meeting-transcript'))).toContainText('take the dashboard?')
  await expect(tab.locator(sel('meeting-speaker'))).toContainText('Todd is speaking')
  await proofShot(app, shell, 'after-tab', { phase: 'live-meeting' })

  // 3. A quick ask lands in Astra's thread as Isaac's words, sent like the composer sends them
  // (`agent.reply` to her session; main adds the device surface line in front, as for any prompt).
  await tab.locator(sel('meeting-quick-ask')).first().click()
  await expect
    .poll(() =>
      host.commands
        .filter((c) => c.cmd.kind === 'agent.reply' && c.cmd.sessionId === 'astra-1')
        .map((c) => String(c.cmd.text).split('\n').at(-1)),
    )
    .toContain('What did I miss?')

  // 4. More said: the transcript rolls and the speaker follows.
  host.meetingLive(ID, [
    {
      id: 'l9',
      track: 'app',
      speaker: 'Chris',
      startMs: at('16:50'),
      endMs: at('16:54'),
      text: 'I can pair on the Flyway script.',
      final: false,
    },
  ])
  await expect(tab.locator(sel('meeting-speaker'))).toContainText('Chris is speaking')

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
  await expect(tab.locator(sel('meeting-tab-summary'))).toContainText('failures dashboard')
  await proofShot(app, shell, 'after-ended', { phase: 'live-meeting' })
})
