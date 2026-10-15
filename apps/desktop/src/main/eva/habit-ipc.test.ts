import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { makeEvaFixture } from '../../../e2e/helpers/eva-fixture'
import { FAKE_GATE } from '../../../e2e/helpers/paths'
import { issuePhotoToken, takePhotoToken } from './photo-tokens'
import { choosePhoto, createHabitService, PHOTO_EXTENSIONS, runGate } from './habit-ipc'
import { buildCommand } from './spawn'
import { openPathChecked } from './open-path'

const fixtures: Array<{ cleanup(): void }> = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
  delete process.env.FAKE_GATE_STATE
  delete process.env.FAKE_LOG
  delete process.env.FAKE_GATE_PHOTOS
  delete process.env.FAKE_GATE_MINUTE_MS
})

function setup() {
  const fx = makeEvaFixture({ minuteMs: 5 })
  fixtures.push(fx)
  Object.assign(process.env, {
    FAKE_GATE_STATE: fx.env.FAKE_GATE_STATE,
    FAKE_LOG: fx.env.FAKE_LOG,
    FAKE_GATE_PHOTOS: fx.env.FAKE_GATE_PHOTOS,
    FAKE_GATE_MINUTE_MS: fx.env.FAKE_GATE_MINUTE_MS,
  })
  const builder = (bin: string) => (argv: string[]) =>
    buildCommand(bin, argv, {
      pathEnv: process.env.PATH ?? '',
      homedir: '/nonexistent',
      execPath: process.execPath,
      baseEnv: process.env,
    })
  const service = createHabitService(builder(FAKE_GATE), fx.root)
  return { fx, service, builder }
}

describe('habit service', () => {
  it('reads status and shares one in-flight read', async () => {
    const { fx, service } = setup()
    const [a, b] = await Promise.all([service.status(), service.status()])
    expect(a.habits).toHaveLength(2)
    expect(b).toBe(a)
    expect(fx.gateLog()).toHaveLength(1)
  })

  it('habit-add runs the right argv and returns the new status', async () => {
    const { fx, service } = setup()
    const s = await service.run({ action: 'habit-add', name: 'Read', minutes: 15, photo: false })
    expect(s.habits.map((h) => h.id)).toContain('read')
    const argv = (fx.gateLog().at(-1) as { argv: string[] }).argv
    expect(argv).toEqual(['habit', 'add', 'Read', '--minutes', '15', '--json'])
  })

  it('maps CLI errors, non-JSON failures and timeouts to gate-error', async () => {
    const { fx, service, builder } = setup()
    await expect(service.run({ action: 'habit-rm', id: 'x' })).rejects.toMatchObject({
      code: 'gate-error',
      message: 'unknown habit: x',
    })
    const bad = await runGate(builder('/bin/sh'), fx.root, ['-c', 'echo boom >&2; exit 3']).catch(
      (e: Error & { code: string }) => e,
    )
    expect(bad).toMatchObject({ code: 'gate-error', message: 'The habit gate failed: boom' })
  })

  it('refuses unsafe args as invalid-input without spawning', async () => {
    const { fx, service } = setup()
    await expect(
      service.run({ action: 'habit-add', name: '--x', minutes: 5, photo: false }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    expect(fx.gateLog()).toHaveLength(0)
  })

  it('done resolves a photo token once', async () => {
    const { fx, service } = setup()
    const photo = path.join(fx.dir, 'photos', 'walk-proof.png')
    await service.run({ action: 'start', id: 'walk' })
    await new Promise((r) => setTimeout(r, 250))
    const token = issuePhotoToken(photo)
    await service.run({ action: 'done', id: 'walk', photoToken: token })
    const argv = (fx.gateLog().at(-1) as { argv: string[] }).argv
    expect(argv).toEqual(['done', 'walk', '--photo', photo, '--json'])
    await expect(
      service.run({ action: 'done', id: 'walk', photoToken: token }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      service.run({ action: 'done', id: 'walk', photoToken: 'nope' }),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })
})

describe('photo tokens', () => {
  it('are single use and expire', () => {
    const t = issuePhotoToken('/a/b.png', 1000)
    expect(takePhotoToken(t, 1000 + 11 * 60 * 1000)).toBeNull()
    const u = issuePhotoToken('/a/c.png', 1000)
    expect(takePhotoToken(u, 2000)).toBe('/a/c.png')
    expect(takePhotoToken(u, 2000)).toBeNull()
  })
})

describe('habit.openPhoto confinement', () => {
  it('allows a file in the photos dir and refuses others', async () => {
    const { fx } = setup()
    const photos = path.join(fx.dir, 'photos')
    fs.mkdirSync(photos, { recursive: true })
    fs.writeFileSync(path.join(photos, 'p.png'), 'x')
    const ctx = { env: { evaRoot: fx.root, e2e: false } } as never
    const seen: string[] = []
    const opener = async (p: string) => (seen.push(p), '')
    await openPathChecked(ctx, path.join(photos, 'p.png'), {
      allowRoots: [photos],
      allowExts: PHOTO_EXTENSIONS,
      opener,
    })
    expect(seen).toHaveLength(1)
    fs.writeFileSync(path.join(photos, 'x.command'), 'x')
    await expect(
      openPathChecked(ctx, path.join(photos, 'x.command'), {
        allowRoots: [photos],
        allowExts: PHOTO_EXTENSIONS,
        opener,
      }),
    ).rejects.toMatchObject({ code: 'open-failed' })
    for (const p of ['/etc/hosts', path.join(photos, '..', 'gate.json')]) {
      await expect(openPathChecked(ctx, p, { allowRoots: [photos], opener })).rejects.toMatchObject(
        { code: 'open-failed' },
      )
    }
  })
})

describe('habit.choosePhoto', () => {
  it('issues a single-use token for the chosen file and passes image filters', async () => {
    const calls: unknown[] = []
    const dlg = (r: { canceled: boolean; filePaths: string[] }) => () => ({
      showOpenDialog: async (_w: never, o: unknown) => (calls.push(o), r),
    })
    const got = await choosePhoto({}, dlg({ canceled: false, filePaths: ['/tmp/x.png'] }))
    expect(got.name).toBe('x.png')
    expect(takePhotoToken(got.token!)).toBe('/tmp/x.png')
    expect(takePhotoToken(got.token!)).toBeNull()
    expect(calls[0]).toMatchObject({
      buttonLabel: 'Use photo',
      properties: ['openFile'],
      filters: [{ extensions: ['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp'] }],
    })
    expect(await choosePhoto({}, dlg({ canceled: true, filePaths: [] }))).toEqual({
      token: null,
      name: null,
    })
  })
})
