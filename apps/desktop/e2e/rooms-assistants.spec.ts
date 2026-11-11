import type { Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test as base, expect } from './fixtures'
import { EVA_FIXTURE_ROOT, REPO_ROOT } from './helpers/paths'

// Assistants > Rooms (slice 1): the Rooms section under the assistants, a Debate room made on the
// New room page with a custom member on an exact model from the fake omp catalog, the empty idle
// room with its notch avatar stack and hover card, then Rename, Duplicate and Delete from the
// row's right-click menu. The Eva root is a temp copy, so room.json files land there.
const PROOF = path.join(REPO_ROOT, 'proof', 'rooms-assistants')
let evaRoot = ''

const test = base.extend({
  launchEnv: async ({}, use) => {
    evaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rooms-eva-'))
    fs.cpSync(EVA_FIXTURE_ROOT, evaRoot, { recursive: true })
    fs.rmSync(path.join(evaRoot, 'work', 'rooms'), { recursive: true, force: true })
    fs.mkdirSync(path.join(evaRoot, '.omp/assistant'), { recursive: true })
    fs.writeFileSync(
      path.join(evaRoot, '.omp/assistant/agents.json'),
      JSON.stringify({
        agents: [
          { id: 'nova', title: 'Nova', scope: 'Personal', model: 'anthropic/claude-opus-5-5' },
        ],
      }),
    )
    await use({ EVAOS_EVA_ROOT: evaRoot })
    fs.rmSync(evaRoot, { recursive: true, force: true })
  },
})
test.use({ startOnChat: false, toolPanes: false, colorScheme: 'dark' })

const sel = (id: string): string => `[data-testid="${id}"]`
const shot = async (shell: Page, name: string): Promise<void> => {
  fs.mkdirSync(PROOF, { recursive: true })
  await shell.screenshot({ path: path.join(PROOF, name) })
}
const roomIds = (): string[] => {
  const dir = path.join(evaRoot, 'work', 'rooms')
  return fs.existsSync(dir) ? fs.readdirSync(dir) : []
}
const saved = (
  id: string,
): {
  kind: string
  room: {
    phase: string
    title: string
    chat: { setup: { members: { name: string; model: string }[] } }
  }
} => JSON.parse(fs.readFileSync(path.join(evaRoot, 'work', 'rooms', id, 'room.json'), 'utf8'))

test('rooms live under Assistants: new idle room, notch stack, rename, duplicate, delete', async ({
  shell,
}) => {
  await shell.locator(sel('nav-assistants')).click()
  await expect(shell.locator(sel('sidebar-sub-assistants'))).toBeVisible()
  await expect(shell.locator(sel('assistants-rooms'))).toBeVisible()
  await expect(shell.locator(sel('sidebar-room-new'))).toBeVisible()
  await expect(shell.locator(sel('nav-rooms'))).toHaveCount(0)

  // New room: Debate fills Nova and two custom agents; one becomes "Skeptic" on an exact model.
  await shell.locator(sel('rooms-new-button')).click()
  await expect(shell.locator(sel('room-form'))).toBeVisible()
  await expect(shell.locator(sel('room-member-row-0'))).toContainText('Nova')
  await shell.locator(sel('room-member-name-1')).fill('Skeptic')
  await shell.locator(sel('room-member-model-picker-1')).click()
  await shell.locator(sel('room-member-model-picker-1-search')).fill('text-only')
  await shell.locator(sel('room-member-model-picker-1-option-fake/text-only')).click()
  await expect(shell.locator(sel('room-member-model-picker-1'))).toContainText('fake/text-only')
  await shot(shell, 's1-new-room.png')
  await shell.locator(sel('room-submit')).click()

  // The empty idle room: notch stack, quiet hint, the composer; the row says Idle.
  await expect(shell.locator(sel('room-empty'))).toBeVisible()
  await expect.poll(roomIds).toHaveLength(1)
  const [id] = roomIds()
  const row = shell.locator(sel(`sidebar-room-${id}`))
  await expect(row).toContainText('New room')
  await expect(row).toContainText('Idle')
  await expect(shell.locator(sel('room-title'))).toHaveText('New room')
  await expect(shell.locator(`${sel('room-stack')} [data-testid^="room-member-"]`)).toHaveCount(3)
  await expect(shell.locator(sel('room-composer'))).toHaveAttribute(
    'placeholder',
    'Message the room, or @mention a member',
  )
  const file = saved(id!)
  expect(file.kind).toBe('chat')
  expect(file.room.phase).toBe('idle')
  expect(file.room.chat.setup.members.map((m) => [m.name, m.model])).toEqual([
    ['Nova', 'anthropic/claude-opus-5-5'],
    ['Skeptic', 'fake/text-only'],
    ['Agent 3', expect.any(String)],
  ])
  // A member keeps the id it was made with ("agent-2") when its name changes.
  await shell.locator(sel('room-member-agent-2')).hover()
  await expect(shell.locator(sel('room-member-model-agent-2'))).toHaveText('fake/text-only')
  await shot(shell, 's1-empty-room-hover.png')

  // Rename in place from the row's menu; an idle room offers no Pause or Resume.
  await row.click({ button: 'right' })
  await expect(shell.locator(sel('room-menu'))).toBeVisible()
  await expect(shell.locator(sel('room-menu-pause'))).toHaveCount(0)
  await expect(shell.locator(sel('room-menu-resume'))).toHaveCount(0)
  await shot(shell, 's1-room-menu.png')
  await shell.locator(sel('room-menu-rename')).click()
  await shell.locator(sel('room-rename-input')).fill('Weapons debate')
  await shell.locator(sel('room-rename-input')).press('Enter')
  await expect(shell.locator(sel('room-title'))).toHaveText('Weapons debate')
  await expect.poll(() => saved(id!).room.title).toBe('Weapons debate')

  // Duplicate: the same setup, idle, " copy" after the title.
  await row.click({ button: 'right' })
  await shell.locator(sel('room-menu-duplicate')).click()
  await expect.poll(roomIds).toHaveLength(2)
  const copy = roomIds().find((r) => r !== id)!
  await expect(shell.locator(sel(`sidebar-room-${copy}`))).toContainText('Weapons debate copy')
  expect(saved(copy).room.chat.setup.members).toEqual(saved(id!).room.chat.setup.members)

  // Delete behind the confirm: the row and its folder go.
  await shell.locator(sel(`sidebar-room-${copy}`)).click({ button: 'right' })
  await shell.locator(sel('room-menu-delete')).click()
  await shell.locator(sel('room-delete-ok')).click()
  await expect(shell.locator(sel(`sidebar-room-${copy}`))).toHaveCount(0)
  expect(roomIds()).toEqual([id])
  await shot(shell, 's1-after-delete.png')
})
