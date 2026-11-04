import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { makeChatFixture, type ChatFixture } from './helpers/chat-fixture'
import { FakeRelayHost } from './helpers/fake-relay-host'
import { EVA_FIXTURE_ROOT } from './helpers/paths'
import { pickScheme } from './helpers/appearance'

// An assistant's header portrait turns editable: hovering shows a pencil, clicking opens Edit
// avatar / Edit instructions. Edit instructions asks the assistant in chat; Edit avatar drops the
// live avatar editor (a native OpenUI widget, drawn locally) into the thread, and Save sends
// "Save my avatar: {json}" as the next turn. AVATAR_PROOF=<dir> also writes screenshots there.
const PROOF = process.env.AVATAR_PROOF ?? ''

const NOVA = {
  style: 'micah',
  seed: 'nova-17',
  options: {
    base: ['standard'],
    earringsProbability: 0,
    ears: ['attached'],
    eyebrows: ['eyelashesDown'],
    eyes: ['eyes'],
    facialHairProbability: 0,
    glasses: ['round'],
    glassesProbability: 100,
    hair: ['full'],
    hairProbability: 100,
    mouth: ['smile'],
    nose: ['curve'],
    shirt: ['crew'],
    baseColor: ['b16a5b'],
    hairColor: ['e0ddff'],
    shirtColor: ['000000'],
  },
  colors: { paper: '#e7f5ff', accent: '#f76707' },
}

let fx: ChatFixture
let host: FakeRelayHost
const test = base.extend({
  launchEnv: async ({}, use) => {
    fx = makeChatFixture()
    const evaRoot = path.join(fx.root, 'eva-root')
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({ agents: [{ id: 'nova', title: 'Nova', scope: 'Personal', avatar: NOVA }] }),
    )
    const relayDir = path.join(fx.root, 'relay')
    host = await FakeRelayHost.start(relayDir)
    await use({ ...fx.launchEnv, EVAOS_EVA_ROOT: evaRoot, EVAOS_RELAY_DIR: relayDir })
    await host.close()
    fx.cleanup()
  },
})
test.use({ startOnChat: false, toolPanes: false })

const sel = (id: string): string => `[data-testid="${id}"]`
const line = (entry: unknown): string => JSON.stringify(entry)

test('the header pencil opens Edit avatar and Edit instructions; Save sends the avatar to the assistant', async ({
  shell,
}) => {
  const file = path.join(fx.sessionsDir, '2026-11-04T10-00-00-000Z_nova-1.jsonl')
  fs.writeFileSync(
    file,
    [
      line({
        type: 'session',
        version: 3,
        id: 'nova-1',
        timestamp: new Date().toISOString(),
        cwd: fx.root,
      }),
      line({
        type: 'message',
        id: 'u1',
        parentId: null,
        message: { role: 'user', content: 'Hi Nova' },
      }),
      line({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi Isaac!' }],
          stopReason: 'stop',
        },
      }),
    ].join('\n') + '\n',
  )
  host.upsert({ id: 'nova-1', status: 'idle', kind: 'assistant', assistant: 'nova', title: 'Nova' })
  await shell.locator(sel('nav-assistants')).click()
  await shell.locator(sel('sidebar-agent-nova')).click()
  await expect(shell.locator(sel('chat-log'))).toContainText('Hi Isaac!', { timeout: 10_000 })

  const shot = async (name: string): Promise<void> => {
    if (PROOF !== '') await shell.screenshot({ path: path.join(PROOF, `${name}.png`) })
  }

  // 1. The pencil shows on hover only.
  const pencil = shell.locator(sel('agent-edit-pencil'))
  await expect(pencil).toHaveCSS('opacity', '0')
  await shell.locator(`${sel('agent-notch')} ${sel('agent-portrait-nova')}`).hover()
  await expect(pencil).toHaveCSS('opacity', '1')
  await shot('1-hover-pencil')

  // 2. Click: the menu offers both.
  await pencil.click()
  await expect(shell.locator(sel('agent-edit-avatar'))).toBeVisible()
  await expect(shell.locator(sel('agent-edit-instructions'))).toBeVisible()
  await shot('2-menu')

  // 3. Edit instructions: the ask is Isaac's next turn.
  await shell.locator(sel('agent-edit-instructions')).click()
  await expect
    .poll(() => host.replies().some((r) => r.text.endsWith("I'd like to change your instructions")))
    .toBe(true)

  // 4. Edit avatar: the live editor lands in the thread, starting from Nova's current face.
  await shell.locator(sel('agent-portrait-nova')).first().hover()
  await pencil.click()
  await shell.locator(sel('agent-edit-avatar')).click()
  const editor = shell.locator(sel('avatar-editor'))
  await expect(editor).toBeVisible()
  await expect(editor).toContainText("Nova's avatar")
  await expect(editor.locator(sel('avatar-editor-preview'))).toBeVisible()
  await expect(editor.locator(sel('avatar-editor-part-value'))).toHaveText('Hair: full')
  await expect(editor.locator(`${sel('avatar-editor-preview')} svg path`).first()).toBeAttached()
  await expect(editor.locator(sel('avatar-editor-save'))).toBeDisabled()
  await editor.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot('3-editor-light')
  if (PROOF !== '')
    await editor.screenshot({ path: path.join(PROOF, '3-editor-light-closeup.png') })

  // 5. Edit: talking preview, another hair, a new disc color; dark mode draws the same editor.
  await editor.locator(sel('avatar-editor-face')).getByText('Talking').click()
  await expect(editor.locator(sel('avatar-editor-preview'))).toHaveAttribute(
    'data-state',
    'talking',
  )
  await editor.getByRole('option', { name: 'Hair pixie' }).click()
  await expect(editor.locator(sel('avatar-editor-part-value'))).toHaveText('Hair: pixie')
  await editor.getByRole('button', { name: 'Background #ffe3e3' }).click()
  await pickScheme(shell, 'dark')
  await editor.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await shot('4-editor-dark')
  if (PROOF !== '') await editor.screenshot({ path: path.join(PROOF, '4-editor-dark-closeup.png') })
  await pickScheme(shell, 'light')

  // 6. Save: the message is Isaac's next turn, and the editor closes.
  await editor.locator(sel('avatar-editor-save')).click()
  await expect(shell.locator(sel('avatar-editor'))).toHaveCount(0)
  const saved = (): string | undefined =>
    host.replies().find((r) => r.text.includes('Save my avatar: '))?.text
  await expect.poll(saved).toBeTruthy()
  const text = saved()!
  const sent = JSON.parse(
    text.slice(text.indexOf('Save my avatar: ') + 'Save my avatar: '.length),
  ) as {
    agent: string
    avatar: {
      style: string
      seed: string
      options: Record<string, string[]>
      colors: Record<string, string>
    }
  }
  expect(sent.agent).toBe('nova')
  expect(sent.avatar.style).toBe('micah')
  expect(sent.avatar.seed).toBe('nova-17')
  expect(sent.avatar.options['hair']).toEqual(['pixie'])
  expect(sent.avatar.options['glasses']).toEqual(['round'])
  expect(sent.avatar.colors).toEqual({ paper: '#ffe3e3', accent: '#f76707' })
})
